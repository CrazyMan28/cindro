// Compile jarvis-tui into a self-contained binary. `bun build --compile` on
// the CLI can't apply the Solid JSX transform, so this goes through
// Bun.build() with @opentui/solid's bun plugin (same approach OpenCode's
// build.ts uses).
//
// Usage:
//   bun run script/build.ts            → host binary (dist/jarvis-tui)
//   bun run script/build.ts win        → Windows exe (dist/jarvis-tui.exe)
//   bun run script/build.ts all        → both
// So Windows ships every TUI v2 feature — same code, cross-compiled.

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const arg = process.argv[2] ?? "host"
const wantHost = arg === "host" || arg === "all"
const wantWin = arg === "win" || arg === "all"

async function build(target: string | undefined, outfile: string, icon?: string) {
  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin()],
    format: "esm",
    minify: true,
    sourcemap: "none",
    compile: {
      outfile,
      ...(target ? { target: target as never } : {}),
      ...(icon ? { windows: { icon, hideConsole: false } } : {}),
    },
    entrypoints: ["./src/index.tsx"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`built ${outfile}`)
}

if (wantHost) await build(undefined, "dist/jarvis-tui")
if (wantWin) {
  // Cross-compiling for Windows needs OpenTUI's win32 native, which bun only
  // extracts when installing ON Windows (its `os` field filters it out on
  // Linux). So the Windows exe is built by the Windows CI runner (where
  // `bun install` pulls @opentui/core-win32-x64); a Linux dev box can't.
  try {
    // @ts-expect-error — Windows-only native; absent on the Linux dev box.
    await import("@opentui/core-win32-x64")
  } catch {
    console.error(
      "skip: Windows exe must be built on Windows (bun won't extract the\n" +
        "@opentui/core-win32-x64 native on Linux). CI does this on the\n" +
        "self-hosted Windows runner. Source is fully cross-platform.",
    )
    process.exit(wantHost ? 0 : 2)
  }
  // The exe gets the Jarvis arc-reactor icon (same .ico the GUI/installer use).
  await build("bun-windows-x64", "dist/jarvis-tui.exe", "../windows/jarvis.ico")
}
