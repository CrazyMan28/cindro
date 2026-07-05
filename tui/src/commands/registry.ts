// CommandRegistry — ONE declarative command table driving three surfaces
// (keybindings, the Ctrl+K palette, and the "/" slash menu), the OpenCode
// pattern that kills the "TUI commands are stubs of GUI commands" drift
// class. Entries come from three sources merged in one registry:
//   - local:    UI-owned actions registered by pages (run() closures)
//   - manifest: the daemon's ui.manifest builtin command set
//   - custom:   user/Jarvis-authored commands (source:"custom" in the
//               manifest) — executed server-side via command.invoke
// Local registrations win name collisions (they carry the actual behavior
// for builtins the manifest only *describes*).

import fuzzysort from "fuzzysort"

export type CommandKind =
  | "navigate" // jump to a main page
  | "page" // open a data page (popup/route)
  | "picker" // open a picker dialog (model/brain/voice)
  | "session" // chat-session op (new/stop/goal/y/n) — behavior is local
  | "verb" // call a daemon verb
  | "send_chat" // send text into the chat composer
  | "help"
  | "action" // arbitrary local action
  // custom command kinds (executed daemon-side through command.invoke):
  | "prompt"
  | "mcp_tool"
  | "shell"

export interface CommandEntry {
  name: string
  description: string
  kind: CommandKind
  aliases?: string[]
  keybind?: string
  target?: string
  verb?: string
  confirm?: boolean
  hidden?: boolean // keybind-only: excluded from palette + slash menu
  source: "local" | "manifest" | "custom"
  run?: (args: string, ctx: CommandContext) => void | Promise<void>
}

export interface CommandContext {
  navigate(page: string): void
  sendChat(text: string): void
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  notify(message: string, severity?: "info" | "warn" | "error"): void
  openPicker(target: string): void
  openHelp(): void
}

const CUSTOM_KINDS = new Set<string>(["prompt", "mcp_tool", "shell"])

export class CommandRegistry {
  private entries: CommandEntry[] = []

  /** Local UI commands. Re-registering a name replaces the previous entry. */
  registerLocal(entries: Array<Omit<CommandEntry, "source">>): void {
    for (const e of entries) {
      this.remove(e.name)
      this.entries.push({ ...e, source: "local" })
    }
  }

  /**
   * Merge ui.manifest commands. Manifest entries never displace local ones
   * (locals carry the behavior; the manifest describes the shared surface).
   * Previous manifest/custom entries are dropped first so a refetch after
   * ui.manifest.changed is idempotent.
   */
  mergeManifest(manifestCommands: Array<Record<string, unknown>>): void {
    this.entries = this.entries.filter((e) => e.source === "local")
    for (const raw of manifestCommands) {
      const name = raw.name as string
      if (!name || this.find(name)) continue
      const isCustom =
        raw.source === "custom" || CUSTOM_KINDS.has(raw.kind as string)
      this.entries.push({
        name,
        description: (raw.description as string) ?? "",
        kind: (raw.kind as CommandKind) ?? "action",
        aliases: (raw.aliases as string[]) ?? undefined,
        target: (raw.target as string) ?? undefined,
        verb: (raw.verb as string) ?? undefined,
        confirm: Boolean(raw.confirm),
        source: isCustom ? "custom" : "manifest",
      })
    }
  }

  remove(name: string): void {
    this.entries = this.entries.filter((e) => e.name !== name)
  }

  all(): CommandEntry[] {
    return [...this.entries]
  }

  visible(): CommandEntry[] {
    return this.entries.filter((e) => !e.hidden)
  }

  find(nameOrAlias: string): CommandEntry | undefined {
    return this.entries.find(
      (e) => e.name === nameOrAlias || e.aliases?.includes(nameOrAlias),
    )
  }

  /** Ranked fuzzy filter over name + aliases + description (palette + "/"). */
  filter(query: string): CommandEntry[] {
    const pool = this.visible()
    if (!query.trim()) return pool
    const ranked = fuzzysort.go(query, pool, {
      keys: [
        "name",
        (e) => e.aliases?.join(" ") ?? "",
        "description",
      ],
      threshold: -10000,
    })
    return ranked.map((r) => r.obj)
  }

  /**
   * Execute by name/alias. Local run() closures win; otherwise kind-default
   * behavior. Returns false when no such command exists.
   */
  async execute(
    nameOrAlias: string,
    args: string,
    ctx: CommandContext,
  ): Promise<boolean> {
    const entry = this.find(nameOrAlias)
    if (!entry) return false
    if (entry.run) {
      await entry.run(args, ctx)
      return true
    }
    switch (entry.kind) {
      case "navigate":
      case "page":
        ctx.navigate(entry.target ?? entry.name)
        return true
      case "picker":
        ctx.openPicker(entry.target ?? entry.name)
        return true
      case "send_chat":
        ctx.sendChat(args || entry.description)
        return true
      case "help":
        ctx.openHelp()
        return true
      case "verb": {
        if (!entry.verb) {
          ctx.notify(`/${entry.name} has no verb wired`, "error")
          return true
        }
        try {
          const res = await ctx.call(entry.verb, args ? { args } : {})
          const ok = res.ok === undefined ? true : Boolean(res.ok)
          const detail = (res.message as string) || (res.url as string) || ""
          ctx.notify(
            `${ok ? "✓" : "✕"} ${entry.name}${detail ? `  ${detail}` : ""}`,
            ok ? "info" : "error",
          )
        } catch (e) {
          ctx.notify(`${entry.name} failed: ${String(e)}`, "error")
        }
        return true
      }
      case "prompt":
      case "mcp_tool":
      case "shell": {
        // Custom commands execute daemon-side (command.invoke). prompt-kind
        // returns text to send as a chat turn; mcp_tool/shell return
        // {executed, ok, output} since the Phase-0 daemon work.
        try {
          const res = await ctx.call("command.invoke", { name: entry.name, args })
          if (typeof res.prompt === "string") {
            ctx.sendChat(res.prompt)
          } else if (res.executed) {
            const ok = Boolean(res.ok)
            const out = String(res.output ?? "").trim()
            ctx.notify(
              `${ok ? "✓" : "✕"} /${entry.name}${out ? `\n${out.slice(0, 4000)}` : ""}`,
              ok ? "info" : "error",
            )
          } else {
            ctx.notify(
              `/${entry.name} needs a newer jarvisd (no server-side execution)`,
              "warn",
            )
          }
        } catch (e) {
          ctx.notify(`/${entry.name} failed: ${String(e)}`, "error")
        }
        return true
      }
      case "session":
      case "action":
      default:
        // Behavior lives in a local registration; a bare manifest entry of
        // these kinds means the page owning it hasn't registered yet.
        ctx.notify(`/${entry.name} is not available on this screen`, "warn")
        return true
    }
  }
}
