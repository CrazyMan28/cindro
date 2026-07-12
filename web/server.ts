#!/usr/bin/env bun
// Bun-native static server for the built Jarvis web dashboard (web/dist/),
// replacing the old stdlib-only web/serve.py now that the dashboard is a
// real Bun+Vite+SolidJS app rather than plain HTML/JS.
//
// Never proxies the daemon control WebSocket — the browser connects DIRECTLY
// to ws://127.0.0.1:<controlPort>/control/ws, same loopback-only model the
// old serve.py documented. This process only serves static files and, on
// start, prints the resolved control token so `jarvis web start` / `bun
// server.ts` gives you everything needed to open Setup and paste it in.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "dist")

function resolveConfigDir(): string {
  return process.env.JARVIS_CONFIG_DIR || join(homedir(), ".config", "jarvis")
}

/** Mirrors cli/jarvis_cli/config.py's control_token(): env wins, else the
 * per-profile config file. A browser can't read this itself (no filesystem
 * access), which is exactly why we print it here for the user to paste. */
function resolveControlToken(): string {
  const env = process.env.JARVIS_CONTROL_TOKEN
  if (env) return env.trim()
  try {
    return readFileSync(join(resolveConfigDir(), "control_token"), "utf8").trim()
  } catch {
    return ""
  }
}

function parseArgs(argv: string[]) {
  let host = "127.0.0.1"
  let port = parseInt(process.env.JARVIS_WEB_PORT || "8788", 10)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") host = argv[++i] ?? host
    else if (argv[i] === "--port") {
      const parsed = parseInt(argv[++i] ?? "", 10)
      if (Number.isFinite(parsed)) port = parsed
    }
  }
  return { host, port }
}

const { host, port } = parseArgs(process.argv.slice(2))

if (!existsSync(ROOT)) {
  console.error(`[jarvis-web] ${ROOT} not found — run \`bun run build\` first`)
  process.exit(1)
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url)
    let path = url.pathname === "/" ? "/index.html" : url.pathname
    let file = Bun.file(join(ROOT, path))
    if (!(await file.exists())) {
      // Hash-based routing means the server only ever sees "/" — this
      // fallback just covers a stray deep-link request for an unknown path.
      file = Bun.file(join(ROOT, "index.html"))
    }
    return new Response(file, {
      headers: {
        "Cache-Control": "no-store, must-revalidate",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      },
    })
  },
})

const token = resolveControlToken()
console.log(`[jarvis-web] serving ${ROOT} at http://${host}:${server.port}/`)
if (token) {
  console.log(`[jarvis-web] control token: ${token}`)
} else {
  console.log(
    "[jarvis-web] no control token found (~/.config/jarvis/control_token) — " +
      "pair from the desktop app instead (Settings → Browser Extension → Generate pairing code)",
  )
}
console.log("[jarvis-web] Ctrl-C to stop")
