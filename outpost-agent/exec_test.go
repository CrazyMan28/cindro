package main

import (
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
