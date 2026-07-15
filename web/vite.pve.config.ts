import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Build target for the host-served Cindro Proxmox dashboard (a separate SPA
// that reuses web/src/core theme + the Contract A protocol, with a curated
// Proxmox-only page set). Root is src/pve so its index.html builds to
// dist-pve/index.html (what proxmox-dashboard serves). Run: bun run build:pve
export default defineConfig({
  plugins: [solid()],
  root: "src/pve",
  server: { host: "127.0.0.1", port: 8790 },
  build: {
    outDir: "../../dist-pve",
    emptyOutDir: true,
  },
})
