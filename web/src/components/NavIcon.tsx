// Hand-drawn 18x18 line icons, ported 1:1 from NavRail.qml's NavIcon
// component (same Canvas 2D calls — QML's Canvas API and the browser's are
// close enough that these paths translate directly).
import { onMount } from "solid-js"

const GLYPHS: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
  home: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(3, 9); ctx.lineTo(9, 3.5); ctx.lineTo(15, 9); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(4.5, 8); ctx.lineTo(4.5, 15); ctx.lineTo(13.5, 15); ctx.lineTo(13.5, 8); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(7.5, 15); ctx.lineTo(7.5, 11); ctx.lineTo(10.5, 11); ctx.lineTo(10.5, 15); ctx.stroke()
  },
  chat: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(2, 4); ctx.lineTo(16, 4); ctx.lineTo(16, 12); ctx.lineTo(7, 12)
    ctx.lineTo(4, 16); ctx.lineTo(4, 12); ctx.lineTo(2, 12); ctx.closePath(); ctx.stroke()
  },
  computer: (ctx) => {
    ctx.strokeRect(2, 3, 14, 9)
    ctx.beginPath()
    ctx.moveTo(7, 12); ctx.lineTo(6.5, 15.5)
    ctx.lineTo(11.5, 15.5); ctx.lineTo(11, 12); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(5, 15.5); ctx.lineTo(13, 15.5); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(10, 5.5); ctx.lineTo(13.5, 8.5); ctx.lineTo(11.6, 8.7)
    ctx.lineTo(12.7, 10.6); ctx.lineTo(11.6, 11.1); ctx.lineTo(10.6, 9.1)
    ctx.lineTo(9.2, 10.2); ctx.closePath(); ctx.stroke()
  },
  voice: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(6.5, 3.5)
    ctx.arc(9, 3.5, 2.5, Math.PI, 0)
    ctx.lineTo(11.5, 8)
    ctx.arc(9, 8, 2.5, 0, Math.PI)
    ctx.closePath(); ctx.stroke()
    ctx.beginPath()
    ctx.arc(9, 8.5, 4.5, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(9, 13); ctx.lineTo(9, 15.5)
    ctx.moveTo(6, 15.5); ctx.lineTo(12, 15.5)
    ctx.stroke()
  },
  canvas: (ctx) => {
    ctx.strokeRect(2.5, 3, 13, 12)
    ctx.beginPath()
    ctx.moveTo(9, 6); ctx.lineTo(9, 12)
    ctx.moveTo(6, 9); ctx.lineTo(12, 9)
    ctx.moveTo(6.8, 6.8); ctx.lineTo(11.2, 11.2)
    ctx.moveTo(11.2, 6.8); ctx.lineTo(6.8, 11.2)
    ctx.stroke()
  },
  memory: (ctx) => {
    ctx.strokeRect(4, 4, 10, 10)
    ctx.beginPath(); ctx.arc(9, 9, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(7, 4); ctx.lineTo(7, 1.5)
    ctx.moveTo(11, 4); ctx.lineTo(11, 1.5)
    ctx.moveTo(7, 14); ctx.lineTo(7, 16.5)
    ctx.moveTo(11, 14); ctx.lineTo(11, 16.5)
    ctx.moveTo(4, 7); ctx.lineTo(1.5, 7)
    ctx.moveTo(4, 11); ctx.lineTo(1.5, 11)
    ctx.moveTo(14, 7); ctx.lineTo(16.5, 7)
    ctx.moveTo(14, 11); ctx.lineTo(16.5, 11)
    ctx.stroke()
  },
  skills: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(10, 1.5); ctx.lineTo(4, 9.5); ctx.lineTo(8.5, 9.5)
    ctx.lineTo(7.5, 16.5); ctx.lineTo(14, 8); ctx.lineTo(9.5, 8)
    ctx.closePath(); ctx.stroke()
  },
  agents: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 7, 3.4, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(3.5, 16); ctx.quadraticCurveTo(9, 10, 14.5, 16); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(9, 3.6); ctx.lineTo(9, 1.5); ctx.stroke()
    ctx.beginPath(); ctx.arc(9, 1.2, 0.9, 0, Math.PI * 2); ctx.fill()
  },
  browser: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(9, 2); ctx.quadraticCurveTo(3, 9, 9, 16); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(9, 2); ctx.quadraticCurveTo(15, 9, 9, 16); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(2, 9); ctx.lineTo(16, 9)
    ctx.moveTo(3.2, 5.5); ctx.lineTo(14.8, 5.5)
    ctx.moveTo(3.2, 12.5); ctx.lineTo(14.8, 12.5); ctx.stroke()
  },
  schedules: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(9, 9); ctx.lineTo(9, 4.5)
    ctx.moveTo(9, 9); ctx.lineTo(12.5, 10.5); ctx.stroke()
  },
  activity: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(1.5, 9); ctx.lineTo(5, 9); ctx.lineTo(7, 3.5)
    ctx.lineTo(10, 14.5); ctx.lineTo(12, 9); ctx.lineTo(16.5, 9)
    ctx.stroke()
  },
  memorygraph: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(9, 4); ctx.lineTo(4, 13.5)
    ctx.moveTo(9, 4); ctx.lineTo(14, 13.5)
    ctx.moveTo(4, 13.5); ctx.lineTo(14, 13.5)
    ctx.stroke()
    ctx.beginPath(); ctx.arc(9, 4, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(4, 13.5, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(14, 13.5, 2, 0, Math.PI * 2); ctx.stroke()
  },
  outpost: (ctx) => {
    // mast + base
    ctx.beginPath(); ctx.moveTo(9, 6); ctx.lineTo(9, 15.5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(6, 15.5); ctx.lineTo(12, 15.5); ctx.stroke()
    // beacon node
    ctx.beginPath(); ctx.arc(9, 5, 1.6, 0, Math.PI * 2); ctx.stroke()
    // signal arcs
    ctx.beginPath(); ctx.arc(9, 5, 3.8, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke()
    ctx.beginPath(); ctx.arc(9, 5, 6.2, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke()
  },
  sessions: (ctx) => {
    ctx.strokeRect(2.5, 2.5, 13, 3.5)
    ctx.strokeRect(2.5, 7.5, 13, 3.5)
    ctx.strokeRect(2.5, 12.5, 13, 3.5)
  },
  replay: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(7, 5.5); ctx.lineTo(13, 9); ctx.lineTo(7, 12.5)
    ctx.closePath(); ctx.stroke()
  },
  settings: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 9, 3.2, 0, Math.PI * 2); ctx.stroke()
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      ctx.beginPath()
      ctx.moveTo(9 + Math.cos(a) * 5, 9 + Math.sin(a) * 5)
      ctx.lineTo(9 + Math.cos(a) * 7.5, 9 + Math.sin(a) * 7.5)
      ctx.stroke()
    }
  },
  mcp: (ctx) => {
    ctx.beginPath(); ctx.arc(9, 4, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(4, 14, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(14, 14, 2, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(9, 6); ctx.lineTo(5, 12.5)
    ctx.moveTo(9, 6); ctx.lineTo(13, 12.5)
    ctx.moveTo(6, 14); ctx.lineTo(12, 14); ctx.stroke()
  },
  plugins: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(3, 5); ctx.lineTo(7, 5); ctx.lineTo(7, 3.5)
    ctx.lineTo(11, 3.5); ctx.lineTo(11, 5); ctx.lineTo(15, 5)
    ctx.lineTo(15, 15); ctx.lineTo(3, 15); ctx.closePath(); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(7, 9.5); ctx.lineTo(11, 9.5); ctx.stroke()
  },
  widgets: (ctx) => {
    ctx.strokeRect(2.5, 2.5, 5.5, 5.5)
    ctx.strokeRect(10, 2.5, 5.5, 5.5)
    ctx.strokeRect(2.5, 10, 5.5, 5.5)
    ctx.strokeRect(10, 10, 5.5, 5.5)
  },
  phone: (ctx) => {
    ctx.beginPath()
    ctx.arc(5, 5, 2.5, Math.PI * 0.55, Math.PI * 1.45)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(13, 13, 2.5, Math.PI * 1.55, Math.PI * 0.45)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(3.3, 7.0); ctx.lineTo(11.0, 14.7); ctx.stroke()
  },
}

export function NavIcon(props: { glyph: string; color: string; glow?: boolean }) {
  let canvas: HTMLCanvasElement | undefined

  const paint = () => {
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = 18 * dpr
    canvas.height = 18 * dpr
    canvas.style.width = "18px"
    canvas.style.height = "18px"
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, 18, 18)
    ctx.strokeStyle = props.color
    ctx.fillStyle = props.color
    ctx.lineWidth = 1.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    const draw = GLYPHS[props.glyph] ?? GLYPHS.widgets
    draw(ctx)
  }

  onMount(paint)

  return (
    <canvas
      ref={(r) => {
        canvas = r
        queueMicrotask(paint)
      }}
      class="nav-icon"
      classList={{ glow: props.glow }}
      style={{ width: "18px", height: "18px", "flex-shrink": 0 }}
    />
  )
}
