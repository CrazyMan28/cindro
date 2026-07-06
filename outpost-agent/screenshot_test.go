package main

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
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
