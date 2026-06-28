#!/usr/bin/env python3
"""jarvice_voice.py — speak text in a cloned voice via Mistral Voxtral TTS.

Zero-shot voice cloning the way Mistral *actually* does it: there is no
"create a saved voice / voice_id" call (that part of the usual ChatGPT/Gemini
snippet is wrong). Instead you pass a short reference clip as `ref_audio`
(base64) on each POST /v1/audio/speech request and Mistral clones it on the fly.

This is the same endpoint the Jarvis daemon's VoiceService already hits, so a
clip that sounds good here will sound the same inside Voice Mode.

Usage:
  # Build a clean mono reference clip from a longer recording (one-time):
  python3 scripts/jarvice_voice.py build-ref source.mp3 --start 19.2 --dur 15

  # Speak something in the cloned voice (writes + plays a wav):
  python3 scripts/jarvice_voice.py say "Good morning, sir." -o greeting.wav

  # Live Form-Coach style callout (no playback wait, fire-and-forget):
  python3 scripts/jarvice_voice.py say "Keep your guard up, sir." --no-play

The Mistral key is read from $MISTRAL_API_KEY or ~/.config/jarvis/mistral_api_key
(the daemon's key file) — it never has to be pasted in.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.mistral.ai/v1/audio/speech"
# Pinned dated model so behavior doesn't shift under us; -latest also works.
MODEL = "voxtral-mini-tts-2603"
DEFAULT_REF = Path.home() / ".config" / "jarvis" / "voices" / "jarvice_ref.mp3"


def _api_key() -> str:
    key = os.getenv("MISTRAL_API_KEY")
    if key:
        return key.strip()
    key_file = Path.home() / ".config" / "jarvis" / "mistral_api_key"
    if key_file.exists():
        return key_file.read_text().strip()
    sys.exit("No Mistral API key: set $MISTRAL_API_KEY or write ~/.config/jarvis/mistral_api_key")


def build_ref(source: str, start: float, dur: float, out: Path = DEFAULT_REF) -> Path:
    """Trim a clean mono, loudness-normalized reference clip with ffmpeg."""
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found — needed to build the reference clip")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(start), "-t", str(dur), "-i", source,
        "-ac", "1", "-ar", "24000",
        # 80Hz highpass kills rumble; loudnorm evens out the level for cloning.
        "-af", "highpass=f=80,loudnorm=I=-18:TP=-1.5:LRA=11",
        "-c:a", "libmp3lame", "-q:a", "2", str(out),
    ]
    subprocess.run(cmd, check=True)
    print(f"reference clip -> {out} ({out.stat().st_size} bytes, {dur}s mono)")
    return out


def synth(text: str, ref_path: Path = DEFAULT_REF, fmt: str = "wav",
          timeout: int = 60) -> bytes:
    """Return synthesized audio bytes cloned from ref_path."""
    if not ref_path.exists():
        sys.exit(f"reference clip missing: {ref_path}\n"
                 f"  build one: jarvice_voice.py build-ref <source> --start S --dur D")
    ref_b64 = base64.b64encode(ref_path.read_bytes()).decode()
    body = json.dumps({
        "model": MODEL,
        "input": text,
        "ref_audio": ref_b64,
        "response_format": fmt,
    }).encode()
    req = urllib.request.Request(
        API_URL, data=body,
        headers={"Authorization": f"Bearer {_api_key()}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        sys.exit(f"Mistral TTS HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"Mistral TTS network error: {e.reason}")
    b64 = payload.get("audio_data")
    if not b64:
        sys.exit(f"no audio_data in response: {json.dumps(payload)[:400]}")
    return base64.b64decode(b64)


def _play(path: Path) -> None:
    for player in ("mpv", "aplay", "ffplay"):
        exe = shutil.which(player)
        if not exe:
            continue
        args = [exe]
        if player == "mpv":
            args += ["--no-terminal", "--really-quiet"]
        elif player == "ffplay":
            args += ["-nodisp", "-autoexit", "-loglevel", "quiet"]
        subprocess.run(args + [str(path)])
        return
    print("(no audio player found — install mpv or alsa-utils to hear it)")


def say(text: str, ref_path: Path, out: Path, fmt: str, play: bool) -> Path:
    audio = synth(text, ref_path=ref_path, fmt=fmt)
    out.write_bytes(audio)
    print(f"jarvice: {text!r} -> {out} ({len(audio)} bytes)")
    if play:
        _play(out)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Cloned-voice TTS via Mistral Voxtral (ref_audio).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build-ref", help="trim a clean reference clip from a recording")
    b.add_argument("source", help="source audio/video file (mp3/mp4/wav...)")
    b.add_argument("--start", type=float, default=0.0, help="start seconds")
    b.add_argument("--dur", type=float, default=15.0, help="duration seconds (10-20 is plenty)")
    b.add_argument("--out", type=Path, default=DEFAULT_REF)

    s = sub.add_parser("say", help="speak text in the cloned voice")
    s.add_argument("text")
    s.add_argument("-o", "--out", type=Path, default=Path("jarvice_out.wav"))
    s.add_argument("--ref", type=Path, default=DEFAULT_REF)
    s.add_argument("--format", default="wav", choices=["wav", "mp3", "opus", "pcm", "flac"])
    s.add_argument("--no-play", dest="play", action="store_false", help="don't play after writing")

    args = ap.parse_args(argv)
    if args.cmd == "build-ref":
        build_ref(args.source, args.start, args.dur, args.out)
    elif args.cmd == "say":
        say(args.text, args.ref, args.out, args.format, args.play)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
