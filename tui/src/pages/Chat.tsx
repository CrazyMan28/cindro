// Chat page — SessionController + Transcript + docked pending bar +
// Composer, plus the chat-owned command registrations (new/stop/goal/y/n,
// model/provider pickers, diff verbs with their real param shapes). Global
// y/a/n approval keys and 1-9 question keys are active only while the
// matching prompt is pending AND the composer is empty, so typing normal
// text never triggers them.

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { Composer } from "../chat/Composer"
import { Picker } from "../chat/Picker"
import type { SessionController } from "../chat/session"
import { Transcript } from "../chat/Transcript"
import { theme } from "../theme"

export interface ChatProps {
  session: SessionController
  active: () => boolean
}

interface PickerState {
  title: string
  options: Array<{ label: string; description?: string; value: string }>
  onPick: (value: string) => void
}

export function Chat(props: ChatProps) {
  const app = useApp()
  const session = props.session
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [composerText, setComposerText] = createSignal("")

  const send = (text: string) => {
    void session.send(text).catch((e) => session.notice(String(e), "error"))
  }

  const openBrainOrModelPicker = async (which: "brain" | "model") => {
    try {
      const s = await app.client.call("settings.get", {}, 8000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      if (which === "brain") {
        const brains = ((settings.brains ?? ["codex", "claude", "api"]) as unknown[]).map(String)
        const avail = (settings.available_brains ?? {}) as Record<string, unknown>
        setPicker({
          title: "DEFAULT BRAIN",
          options: brains.map((b) => ({
            label: b,
            description: avail[b] === false ? "(unavailable on this machine)" : "",
            value: b,
          })),
          onPick: (v) => {
            void app.client
              .call("settings.set", { patch: { default_brain: v } })
              .then(() => session.notice(`✓ default brain: ${v}`, "success"))
              .catch((e) => session.notice(String(e), "error"))
          },
        })
      } else {
        const res = await app.client.call("model.list", {}, 8000)
        const models = ((res.models ?? []) as unknown[]).map(String)
        setPicker({
          title: "DEFAULT MODEL",
          options: models.map((m) => ({ label: m, value: m })),
          onPick: (v) => {
            void app.client
              .call("settings.set", { patch: { default_model: v } })
              .then(() => session.notice(`✓ default model: ${v}`, "success"))
              .catch((e) => session.notice(String(e), "error"))
          },
        })
      }
    } catch (e) {
      session.notice(`picker unavailable: ${String(e)}`, "error")
    }
  }

  const diffAction = async (verb: string, args: string) => {
    // Param shapes mirror Bridge.cpp diffStage/diffRevert/diffCommit/diffOpenPr.
    const params: Record<string, unknown> = {}
    if (session.sessionId()) params.session_id = session.sessionId()
    if (verb === "stage" || verb === "revert") {
      const path = args.trim()
      if (!path) {
        session.notice(`/${verb} needs a file path`, "warn")
        return
      }
      params.path = path
    } else if (args.trim()) {
      params[verb === "commit" ? "message" : "title"] = args.trim()
    }
    const method = verb === "openpr" ? "diff.open_pr" : `diff.${verb}`
    try {
      const res = await app.client.call(method, params)
      const ok = res.ok === undefined ? true : Boolean(res.ok)
      const detail = String(res.message ?? res.url ?? "")
      session.notice(
        `${ok ? "✓" : "✕"} ${verb}${detail ? `  ${detail}` : ""}`,
        ok ? "success" : "error",
      )
    } catch (e) {
      session.notice(`${verb} failed: ${String(e)}`, "error")
    }
  }

  onMount(() => {
    app.registry.registerLocal([
      {
        name: "new",
        description: "start a fresh chat session",
        kind: "session",
        aliases: ["clear"],
        run: () => void session.newSession().catch((e) => session.notice(String(e), "error")),
      },
      {
        name: "stop",
        description: "cancel the in-flight turn",
        kind: "session",
        run: () => void session.stop().catch((e) => session.notice(String(e), "error")),
      },
      {
        name: "goal",
        description: "set a persistent session goal",
        kind: "session",
        run: (args) => void session.setGoal(args).catch((e) => session.notice(String(e), "error")),
      },
      {
        name: "y",
        description: "approve the pending action",
        kind: "session",
        aliases: ["yes"],
        run: () =>
          void session.respondApproval("allow").catch((e) => session.notice(String(e), "error")),
      },
      {
        name: "n",
        description: "deny the pending action",
        kind: "session",
        aliases: ["no"],
        run: () =>
          void session.respondApproval("deny").catch((e) => session.notice(String(e), "error")),
      },
      {
        name: "provider",
        description: "pick the default brain",
        kind: "picker",
        aliases: ["brain"],
        run: () => void openBrainOrModelPicker("brain"),
      },
      {
        name: "model",
        description: "pick the default model",
        kind: "picker",
        run: () => void openBrainOrModelPicker("model"),
      },
      {
        name: "stage",
        description: "git add a reviewed file",
        kind: "verb",
        run: (args) => void diffAction("stage", args),
      },
      {
        name: "commit",
        description: "commit staged changes",
        kind: "verb",
        run: (args) => void diffAction("commit", args),
      },
      {
        name: "revert",
        description: "discard local changes to a file",
        kind: "verb",
        run: (args) => void diffAction("revert", args),
      },
      {
        name: "openpr",
        description: "push + open a pull request",
        kind: "verb",
        run: (args) => void diffAction("openpr", args),
      },
      {
        name: "tui",
        description: "ask Jarvis to build a custom page",
        kind: "send_chat",
        run: (args) =>
          send(
            `Please create a custom TUI page for me using the tui_add_page tool` +
              (args ? `: ${args}` : ` — pick something useful based on our recent work.`),
          ),
      },
    ])
  })

  // Approval y/a/n + question 1-9 shortcuts — active only while pending AND
  // the composer is empty (typing normal text must never trigger them).
  useKeyboard(
    (key: { name?: string; ctrl?: boolean }) => {
      if (!props.active() || key.ctrl || composerText().length > 0 || picker()) return
      const approval = session.pendingApproval()
      if (approval) {
        if (key.name === "y") void session.respondApproval("allow")
        else if (key.name === "a") void session.respondApproval("always")
        else if (key.name === "n") void session.respondApproval("deny")
        return
      }
      const question = session.pendingQuestion()
      if (question && question.options.length) {
        const n = Number.parseInt(key.name ?? "", 10)
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, question.options.length))
          session.answerQuestion(question.questionId, question.options[n - 1])
      }
    },
    {},
  )

  onCleanup(() => session.dispose())

  const submitText = (text: string) => {
    const question = session.pendingQuestion()
    if (question) {
      // Free-text answer to a pending ask_user question.
      session.answerQuestion(question.questionId, text)
      return
    }
    send(text)
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Transcript
        session={session}
        onWidgetAction={(text) =>
          text.startsWith("/")
            ? void app.registry.execute(
                text.slice(1).split(/\s+/)[0] ?? "",
                text.slice(1).split(/\s+/).slice(1).join(" "),
                {
                  navigate: app.navigate,
                  sendChat: send,
                  call: (m, p) => app.client.call(m, p ?? {}),
                  notify: (msg) => session.notice(msg),
                  openPicker: () => {},
                  openHelp: () => {},
                },
              )
            : send(text)
        }
      />
      <Show when={session.status()}>
        <text fg={theme.textFaint} selectable={false}>
          {session.status()}
        </text>
      </Show>
      <Show when={session.pendingApproval()}>
        {(a) => (
          <box flexDirection="row" gap={1} border borderColor={theme.danger}>
            <text fg={theme.danger} attributes={TextAttributes.BOLD} selectable={false}>
              ✋ {a().summary}
            </text>
            <text fg={theme.textMuted} selectable={false}>
              y allow · a always · n deny
            </text>
          </box>
        )}
      </Show>
      <Composer
        active={props.active}
        onValueChange={setComposerText}
        onSubmitText={submitText}
        onSlash={(name, args) => {
          void app.registry.execute(name, args, {
            navigate: app.navigate,
            sendChat: send,
            call: (m, p) => app.client.call(m, p ?? {}),
            notify: (msg, sev) =>
              session.notice(msg, sev === "error" ? "error" : sev === "warn" ? "warn" : "info"),
            openPicker: (target) =>
              void openBrainOrModelPicker(target === "model" ? "model" : "brain"),
            openHelp: () =>
              session.notice(
                app.registry
                  .visible()
                  .map((e) => `/${e.name} — ${e.description}`)
                  .join("\n"),
                "info",
              ),
          }).then((found) => {
            if (!found) session.notice(`unknown command: /${name}`, "warn")
          })
        }}
      />
      <Show when={picker()}>
        {(p) => (
          <Picker
            title={p().title}
            options={p().options}
            onPick={(v) => {
              setPicker(null)
              p().onPick(v)
            }}
            onCancel={() => setPicker(null)}
          />
        )}
      </Show>
    </box>
  )
}
