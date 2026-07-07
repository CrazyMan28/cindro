package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestRunShellEcho(t *testing.T) {
	ok, code, out, errStr := runShell("echo hello-outpost", 10, "auto")
	if !ok || code != 0 {
		t.Fatalf("expected ok/0, got ok=%v code=%d err=%q", ok, code, errStr)
	}
	if !strings.Contains(out, "hello-outpost") {
		t.Fatalf("output missing marker: %q", out)
	}
}

func TestRunShellNonZero(t *testing.T) {
	ok, code, _, _ := runShell("exit 3", 10, "auto")
	if ok || code != 3 {
		t.Fatalf("expected fail/3, got ok=%v code=%d", ok, code)
	}
}

func TestRunShellTimeout(t *testing.T) {
	ok, _, _, errStr := runShell("sleep 5", 0.2, "auto")
	if ok || errStr != "timeout" {
		t.Fatalf("expected timeout, got ok=%v err=%q", ok, errStr)
	}
}

func TestRunShellOutputCappedWithTruncationMarker(t *testing.T) {
	// Ask the shell to print well beyond maxOutputBytes; runShell must not
	// hand back the full blob, and must clearly mark that it was cut.
	overBy := 50000
	total := maxOutputBytes + overBy
	cmd := fmt.Sprintf("head -c %d /dev/zero | tr '\\0' 'a'", total)
	ok, code, out, _ := runShell(cmd, 30, "auto")
	if !ok || code != 0 {
		t.Fatalf("expected ok/0, got ok=%v code=%d", ok, code)
	}
	if len(out) > maxOutputBytes+200 { // + generous slack for the marker text
		t.Fatalf("output not capped: got %d bytes (cap %d)", len(out), maxOutputBytes)
	}
	if !strings.Contains(out, fmt.Sprintf("output truncated, %d bytes total", total)) {
		t.Fatalf("missing/incorrect truncation marker in output tail: %q",
			out[max(0, len(out)-120):])
	}
}

func TestRunShellUnderCapUntouched(t *testing.T) {
	ok, code, out, _ := runShell("echo small-output", 10, "auto")
	if !ok || code != 0 {
		t.Fatalf("expected ok/0, got ok=%v code=%d", ok, code)
	}
	if strings.Contains(out, "truncated") {
		t.Fatalf("small output should not be marked truncated: %q", out)
	}
}
