// Live host telemetry for the Home dashboard — the GUI's HudStatusStrip/
// HomePage read /proc through the C++ bridge; the TUI reads /proc directly
// (same numbers, no daemon roundtrip). Linux-only by design; every reader
// degrades to null on any error (Windows TUI shows the cards empty).

import { readFileSync } from "node:fs"

export interface SysSnapshot {
  cpuPercent: number | null
  ramPercent: number | null
  ramUsedGb: number | null
  ramTotalGb: number | null
  netUpKbps: number | null
  netDownKbps: number | null
}

interface CpuSample {
  idle: number
  total: number
}

interface NetSample {
  rx: number
  tx: number
  at: number
}

let lastCpu: CpuSample | null = null
let lastNet: NetSample | null = null

function readCpu(): number | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0]
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0) // idle + iowait
    const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    const prev = lastCpu
    lastCpu = { idle, total }
    if (!prev || total <= prev.total) return null
    const dTotal = total - prev.total
    const dIdle = idle - prev.idle
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
  } catch {
    return null
  }
}

function readRam(): { percent: number; usedGb: number; totalGb: number } | null {
  try {
    const info = readFileSync("/proc/meminfo", "utf8")
    const grab = (key: string) => {
      const m = info.match(new RegExp(`${key}:\\s+(\\d+) kB`))
      return m ? Number(m[1]) : NaN
    }
    const total = grab("MemTotal")
    const avail = grab("MemAvailable")
    if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) return null
    const used = total - avail
    return {
      percent: Math.round((used / total) * 100),
      usedGb: Math.round((used / 1048576) * 10) / 10,
      totalGb: Math.round((total / 1048576) * 10) / 10,
    }
  } catch {
    return null
  }
}

function readNet(): { upKbps: number; downKbps: number } | null {
  try {
    let rx = 0
    let tx = 0
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":")
      if (!rest || name.trim() === "lo") continue
      const cols = rest.trim().split(/\s+/).map(Number)
      rx += cols[0] ?? 0
      tx += cols[8] ?? 0
    }
    const now = Date.now()
    const prev = lastNet
    lastNet = { rx, tx, at: now }
    if (!prev || now <= prev.at) return null
    const dt = (now - prev.at) / 1000
    return {
      downKbps: Math.max(0, Math.round((rx - prev.rx) / 1024 / dt)),
      upKbps: Math.max(0, Math.round((tx - prev.tx) / 1024 / dt)),
    }
  } catch {
    return null
  }
}

export function sampleSystem(): SysSnapshot {
  const ram = readRam()
  const net = readNet()
  return {
    cpuPercent: readCpu(),
    ramPercent: ram?.percent ?? null,
    ramUsedGb: ram?.usedGb ?? null,
    ramTotalGb: ram?.totalGb ?? null,
    netUpKbps: net?.upKbps ?? null,
    netDownKbps: net?.downKbps ?? null,
  }
}

/** 5-slot rolling history bar (the GUI HomePage's cpuHist/ramHist look). */
export function historyBars(history: number[]): string {
  const glyphs = ["▁", "▂", "▃", "▅", "▇"]
  return history
    .map((v) => glyphs[Math.max(0, Math.min(4, Math.floor((v / 100) * 4.999)))])
    .join("")
}
