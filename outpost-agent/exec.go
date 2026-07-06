package main

import (
	"bytes"
	"context"
	"os/exec"
	"runtime"
	"time"
)

// runShell runs cmd via the platform shell, returning ok, exitCode, combined
// output, and an error string. shell "auto" => PowerShell on Windows, sh -c
// elsewhere. Full trust — no allow-list (design decision).
func runShell(cmd string, timeoutSec float64, shell string) (bool, int, string, string) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()

	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
			"-Command", cmd)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", cmd)
	}
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return false, -1, buf.String(), "timeout"
	}
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	errStr := ""
	if err != nil && code == -1 {
		errStr = err.Error()
	}
	return err == nil, code, buf.String(), errStr
}
