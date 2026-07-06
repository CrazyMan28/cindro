// Canvas-based rotating arc-reactor rings, ported from the visual spec in
// desktop/qml/ArcReactor.qml (outer ring ~14s, inner ring ~9s, core pulse
// ~2.2s — see theme.ringSlow/ringFast/pulse).
import { onCleanup, onMount } from "solid-js"

import { theme } from "../core/theme"

export function ArcReactor(props: { size?: number; tint?: string }) {
  let canvas: HTMLCanvasElement | undefined
  let raf = 0

  onMount(() => {
    const size = props.size ?? 30
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.scale(dpr, dpr)

    const start = performance.now()

    const draw = (now: number) => {
      const t = now - start
      const cx = size / 2
      const cy = size / 2
      ctx.clearRect(0, 0, size, size)

      // outer ring
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate((t / theme.ringSlow) * Math.PI * 2)
      ctx.strokeStyle = props.tint ?? theme.accent
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(1, size * 0.05)
      ctx.beginPath()
      ctx.arc(0, 0, size * 0.46, 0, Math.PI * 1.4)
      ctx.stroke()
      ctx.restore()

      // inner ring (opposite direction, faster)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate((-t / theme.ringFast) * Math.PI * 2)
      ctx.strokeStyle = theme.accentBright
      ctx.globalAlpha = 0.75
      ctx.lineWidth = Math.max(1, size * 0.04)
      ctx.beginPath()
      ctx.arc(0, 0, size * 0.3, 0, Math.PI * 1.1)
      ctx.stroke()
      ctx.restore()

      // pulsing core
      const pulsePhase = (Math.sin((t / theme.pulse) * Math.PI * 2) + 1) / 2
      ctx.save()
      ctx.translate(cx, cy)
      ctx.fillStyle = theme.accentBright
      ctx.globalAlpha = 0.35 + pulsePhase * 0.4
      ctx.beginPath()
      ctx.arc(0, 0, size * (0.1 + pulsePhase * 0.03), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
  })

  onCleanup(() => cancelAnimationFrame(raf))

  return <canvas ref={canvas} class="arc-reactor" />
}
