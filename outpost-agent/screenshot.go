package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"runtime"
)

// The exact CopyFromScreen capture proven in windows/testlab/screenshot.ps1.
const winShotPS = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$vs  = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
$bmp.Save('%s', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`

// linuxShotTools, tried in order — Wayland (grim) first, then X11 fallbacks.
var linuxShotTools = [][]string{
	{"grim", "%s"},
	{"scrot", "-o", "%s"},
	{"import", "-window", "root", "%s"},
}

func pngDims(data []byte) (int, int, error) {
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// chooseLinuxTool returns the first tool whose binary is on PATH, or "".
func chooseLinuxTool(lookup func(string) (string, error)) []string {
	for _, t := range linuxShotTools {
		if _, err := lookup(t[0]); err == nil {
			return t
		}
	}
	return nil
}

func captureToFile(path string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-Command", fmt.Sprintf(winShotPS, path)).Run()
	}
	tool := chooseLinuxTool(exec.LookPath)
	if tool == nil {
		return errors.New("no screenshot tool found (install grim, scrot, or imagemagick)")
	}
	args := make([]string, len(tool))
	for i, a := range tool {
		if a == "%s" {
			args[i] = path
		} else {
			args[i] = a
		}
	}
	return exec.Command(args[0], args[1:]...).Run()
}

// captureScreen returns base64 PNG + dimensions.
func captureScreen() (string, int, int, error) {
	f, err := os.CreateTemp(os.TempDir(), "outpost-shot-*.png")
	if err != nil {
		return "", 0, 0, err
	}
	path := f.Name()
	f.Close() // capture commands need a path, not an open handle
	defer os.Remove(path)
	if err := captureToFile(path); err != nil {
		return "", 0, 0, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, 0, err
	}
	w, h, err := pngDims(data)
	if err != nil {
		w, h = 0, 0 // capture worked but not a PNG we can measure
	}
	return base64.StdEncoding.EncodeToString(data), w, h, nil
}
