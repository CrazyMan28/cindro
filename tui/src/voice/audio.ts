// audio.ts — the ONLY place external processes are spawned for voice I/O (the
// TS twin of voice_mode.py's Recorder/Player seam, which isolates
// sounddevice/numpy so the orchestration around them stays unit-testable with
// fakes). Bun has no bundled audio-capture/playback API, so this shells out
// to the standard Linux CLI tools instead:
//   record:  `arecord -f S16_LE -r 16000 -c 1 -t wav <tmpfile>` (killed to stop)
//   play:    `aplay <tmpfile>`, falling back to `pw-play <tmpfile>`
//
// `spawnImpl` is swappable (setSpawnImpl) so tests never touch real
// hardware/binaries — they inject a fake that fabricates the WAV file and
// resolves instantly, exercising the exact same recordWav/playWav/
// stopRecording orchestration VoicePage drives in production.

import { randomUUID } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Minimal slice of Bun.Subprocess our orchestration needs — small enough
 * that a test's fake spawn can satisfy it without touching real processes. */
export interface SpawnedProc {
  readonly exited: Promise<number>
  kill(signal?: string): void
}

export type SpawnFn = (cmd: string[]) => SpawnedProc

function realSpawn(cmd: string[]): SpawnedProc {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  return {
    exited: proc.exited,
    kill: (signal) => {
      try {
        proc.kill(signal as never)
      } catch {
        // already exited — nothing to signal
      }
    },
  }
}

let spawnImpl: SpawnFn = realSpawn

/** Test seam: inject a fake process spawner, or pass `null` to restore the
 * real `Bun.spawn`-backed implementation. */
export function setSpawnImpl(fn: SpawnFn | null): void {
  spawnImpl = fn ?? realSpawn
}

function tempWavPath(): string {
  return join(tmpdir(), `jarvis-voice-${randomUUID()}.wav`)
}

// -- recording --------------------------------------------------------------

let current: { proc: SpawnedProc; file: string } | null = null

/** Kill the in-flight recording, if any (a no-op otherwise). Sending SIGINT
 * mirrors Ctrl+C on the arecord CLI, which finalizes the WAV header on the
 * way out instead of leaving a truncated file. */
export function stopRecording(): void {
  if (!current) return
  current.proc.kill("SIGINT")
}

/**
 * Record up to `maxSeconds` of 16kHz mono PCM16 WAV via `arecord`, returning
 * it base64-encoded. Resolves either when `stopRecording()` kills the
 * process or when `maxSeconds` elapses on its own (the same hard backstop
 * voice_mode.py's Recorder enforces underneath the screen-level timer).
 * Never throws — hardware/binary failures come back as `{ error }` so
 * VoicePage can surface them instead of an unhandled rejection.
 */
export async function recordWav(maxSeconds: number): Promise<{ b64: string } | { error: string }> {
  if (current) return { error: "already recording" }
  const file = tempWavPath()
  const seconds = Math.max(1, Math.round(maxSeconds))
  let proc: SpawnedProc
  try {
    proc = spawnImpl([
      "arecord",
      "-f",
      "S16_LE",
      "-r",
      "16000",
      "-c",
      "1",
      "-t",
      "wav",
      "-d",
      String(seconds),
      file,
    ])
  } catch (e) {
    return { error: `arecord not found — install alsa-utils: ${String(e)}` }
  }
  current = { proc, file }
  try {
    await proc.exited
  } finally {
    current = null
  }
  try {
    const bytes = await Bun.file(file).arrayBuffer()
    if (bytes.byteLength === 0) return { error: "no audio captured" }
    return { b64: Buffer.from(bytes).toString("base64") }
  } catch (e) {
    return { error: `failed to read recording: ${String(e)}` }
  } finally {
    await unlink(file).catch(() => {
      // best-effort cleanup — a leftover temp file is not worth failing over
    })
  }
}

// -- playback -----------------------------------------------------------------

/**
 * Play a base64 WAV blob (as returned by `voice.tts`). Tries `aplay` first,
 * falls back to `pw-play` (PipeWire's CLI player, common on newer distros
 * where ALSA's default sink is emulated) if that fails. Throws with a clear
 * message if BOTH fail — callers must surface it, never swallow it.
 */
export async function playWav(b64: string): Promise<void> {
  if (!b64) return
  const file = tempWavPath()
  await writeFile(file, Buffer.from(b64, "base64"))
  try {
    const errors: string[] = []
    for (const player of ["aplay", "pw-play"]) {
      try {
        const proc = spawnImpl([player, file])
        const code = await proc.exited
        if (code === 0) return
        errors.push(`${player} exited with code ${code}`)
      } catch (e) {
        errors.push(`${player}: ${String(e)}`)
      }
    }
    throw new Error(`playback failed — ${errors.join("; ")}`)
  } finally {
    await unlink(file).catch(() => {
      // best-effort cleanup
    })
  }
}
