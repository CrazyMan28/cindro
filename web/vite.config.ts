import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Dev server for the Jarvis web dashboard. The app itself only ever talks to
// the daemon's loopback control WebSocket (ws://127.0.0.1:<controlPort>) —
// Vite here is purely a bundler/dev-server, never a proxy for that connection.
export default defineConfig({
  plugins: [solid()],
  server: {
    host: "127.0.0.1",
    port: 8788,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
