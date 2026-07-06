package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// maxOutputBytes caps captured stdout+stderr per exec call before it's ever
// handed to the WS/JSON/daemon pipeline. The old (deleted) SshAllowList
// capped output at 64KB; this is set higher since modern commands (verbose
// builds, package installs, etc.) can legitimately emit more, but still kept
// bounded so a runaway/misbehaving command can't balloon memory locally or
// blow up the relay/daemon downstream.
const maxOutputBytes = 256 * 1024 // 256KB

// limitedBuffer stores at most capBytes of what's written to it; anything
// beyond that is counted but discarded, so a command producing megabytes of
// output can't grow memory unbounded. Writes are mutex-protected because
// exec.Cmd copies Stdout and Stderr concurrently (in separate goroutines)
// when they're not *os.File, and both are pointed at the same buffer here.
type limitedBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	total    int
	capBytes int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.total += len(p)
	if remaining := l.capBytes - l.buf.Len(); remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		l.buf.Write(p[:remaining])
	}
	return len(p), nil
}

// String returns the captured output, with a clear truncation marker
// appended if more was written than the cap allowed.
func (l *limitedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.total > l.buf.Len() {
		return l.buf.String() + fmt.Sprintf("\n...[output truncated, %d bytes total]", l.total)
	}
	return l.buf.String()
}

// runShell runs cmd via the platform shell, returning ok, exitCode, combined
// output (capped at maxOutputBytes), and an error string. shell "auto" =>
// PowerShell on Windows, sh -c elsewhere. Full trust — no allow-list (design
// decision).
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
	buf := &limitedBuffer{capBytes: maxOutputBytes}
	c.Stdout = buf
	c.Stderr = buf
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
