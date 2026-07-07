package main

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"testing"
)

func TestPngDims(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 12, 7))
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	w, h, err := pngDims(buf.Bytes())
	if err != nil || w != 12 || h != 7 {
		t.Fatalf("got w=%d h=%d err=%v", w, h, err)
	}
}

func TestChooseLinuxToolNoneAvailable(t *testing.T) {
	got := chooseLinuxTool(func(string) (string, error) { return "", errors.New("nope") })
	if got != nil {
		t.Fatalf("expected nil when no tool is on PATH, got %v", got)
	}
}

func TestChooseLinuxToolPicksScrot(t *testing.T) {
	got := chooseLinuxTool(func(name string) (string, error) {
		if name == "scrot" {
			return "/usr/bin/scrot", nil
		}
		return "", errors.New("nope")
	})
	if got == nil || got[0] != "scrot" {
		t.Fatalf("expected scrot, got %v", got)
	}
}

// TestCaptureScreenTempPathsAreUnique guards against the fixed-path race:
// captureScreen must generate a distinct temp file name on every call.
func TestCaptureScreenTempPathsAreUnique(t *testing.T) {
	f1, err := os.CreateTemp(os.TempDir(), "outpost-shot-*.png")
	if err != nil {
		t.Fatal(err)
	}
	f1.Close()
	defer os.Remove(f1.Name())

	f2, err := os.CreateTemp(os.TempDir(), "outpost-shot-*.png")
	if err != nil {
		t.Fatal(err)
	}
	f2.Close()
	defer os.Remove(f2.Name())

	if f1.Name() == f2.Name() {
		t.Fatalf("expected unique temp file paths, got the same path twice: %s", f1.Name())
	}
}

// TestCaptureScreenConcurrent exercises captureScreen from multiple
// goroutines at once (mirroring main.go's `go handle(ctx, c, msg)`
// dispatch) to confirm concurrent screenshot requests no longer race on a
// shared fixed temp path. Skips if no capture tool is available in this
// environment.
func TestCaptureScreenConcurrent(t *testing.T) {
	if runtime.GOOS != "windows" && chooseLinuxTool(exec.LookPath) == nil {
		t.Skip("no screenshot tool available in this environment")
	}

	const n = 4
	var wg sync.WaitGroup
	type result struct {
		w, h int
		err  error
	}
	results := make([]result, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, w, h, err := captureScreen()
			results[i] = result{w: w, h: h, err: err}
		}(i)
	}
	wg.Wait()

	for i, r := range results {
		if r.err != nil {
			t.Fatalf("concurrent capture %d failed: %v", i, r.err)
		}
		if r.w == 0 || r.h == 0 {
			t.Fatalf("concurrent capture %d returned zero dimensions", i)
		}
	}
}
