# Using Jarvis without Codex or Claude (chat with Mistral)

Jarvis's default brains are the **Codex** and **Claude** CLIs. If you have neither
installed, Jarvis falls back to a **direct API brain** — and the recommended choice
there is **Mistral**: fast, capable, multilingual, and the same provider that already
powers Jarvis's voice (Voxtral STT/TTS).

> **TL;DR** — paste a Mistral API key in **Settings → API keys**, and Jarvis works with
> no CLI installed. New chats automatically use `mistral-large-latest`.

## What works with the Mistral (api) brain

| Capability | With Mistral |
|---|---|
| Chat + streaming + sessions + memory + skills | ✅ |
| Voice (STT/TTS via Voxtral) | ✅ (already uses Mistral) |
| Vision (attach a photo, the model sees it) | ✅ |
| Generative widgets / canvas / Home pins | ✅ |
| **Computer use / agents / todo (tool calling)** | ✅ via the agentic tool loop |
| Scheduler, hooks, modes, phone, connectors | ✅ |

The api brain runs an **OpenAI-compatible function-calling loop**: it advertises the
computer-use MCP tools to Mistral, executes the tool calls the model requests, and feeds
results back — so Mistral can actually *drive the computer*, not just chat. (Anthropic
models via the api brain remain chat-only for now — Anthropic uses a different tool format.)

## Get a key + turn it on

1. Create a key at <https://console.mistral.ai/>.
2. Open Jarvis → **Settings → API keys** → paste it in the **Mistral** field → Save.
   (Stored at `~/.config/jarvis/mistral_api_key`, mode 0600 — **never** in git.)
3. Start a new chat. With no `codex`/`claude` on your `PATH`, Jarvis defaults the brain to
   **api / `mistral-large-latest`** automatically. You can also pick it explicitly in the
   brain/model picker (it's listed first).

## How the fallback decides

- The daemon detects whether `codex` and `claude` are on `PATH`
  (`settings.get → available_brains`).
- When the **default** brain is a CLI that isn't installed and you didn't ask for a
  specific brain, a new session falls back to the **api** brain — using Mistral when that
  key is set. An **explicit** brain choice is always honored.
- No key at all → you get a clear "add a Mistral key" prompt instead of a cryptic
  "codex failed to start".

## 429 backoff for unattended sessions

`ApiBrain::Options` has `maxBackoffRetries`/`backoffBaseMs`/`backoffMaxMs`
(default 0 = today's behavior: rotate the credential pool on 429, then fail
the turn once it's exhausted). A long-running unattended session — the
Proxmox workload manager's scheduled tick is the first example
(`docs/PROXMOX_WORKLOAD_MANAGER.md`) — should set these non-zero so a
transient rate limit doesn't just kill the turn: it backs off with
exponential + full jitter (`ApiBrain::backoffDelayMs`) and retries the whole
pool again, up to that many times, before genuinely failing.

## Models offered (api brain)

`mistral-large-latest` (default), `mistral-small-latest`, then `gpt-5.5`, `o4-mini`,
`claude-opus-4-8`, and local `qwen2.5:3b` (Ollama, no key). Mistral chat models are
auto-routed to `https://api.mistral.ai/v1` (OpenAI-compatible).

See also [`VOICE.md`](VOICE.md) (Voxtral voice) and [`STATUS.md`](STATUS.md).
