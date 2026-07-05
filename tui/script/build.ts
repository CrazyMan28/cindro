// Compile jarvis-tui into a self-contained binary. `bun build --compile` on
// the CLI can't apply the Solid JSX transform, so this goes through
// Bun.build() with @opentui/solid's bun plugin (same approach OpenCode's
// build.ts uses). Cross-compile later via compile.target per platform.

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [createSolidTransformPlugin()],
  format: "esm",
  minify: true,
  sourcemap: "none",
  compile: {
    outfile: "dist/jarvis-tui",
  },
  entrypoints: ["./src/index.tsx"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("built dist/jarvis-tui")
