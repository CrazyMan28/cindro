# Orin — Future Features (ideas backlog)

> Cool, genuinely useful features Orin **doesn't have yet** — the "what should we build
> next" list. Not bugs (see [`STATUS.md`](STATUS.md)) and not Windows-parity gaps
> (see [`WINDOWS.md`](WINDOWS.md)) — brand-new capabilities.
>
> _Started 2026-06-30._

---

## ⭐ Starting on now: "What's on my screen?" hotkey

Press one global hotkey **anywhere** → Orin grabs the current screen and you ask about
whatever you're looking at (a weird error, a chart, a menu in another language, a contract).
No copy-paste, no "take a screenshot and attach it." Instant, frictionless, always-there.

**Why it's great:** it's the single feature that makes Orin feel like *actual* Orin —
ambient, one keypress away, understands context without being told.

**Rough shape (fits what already exists):**
- A **global hotkey** → capture the current screen (the engine already has
  `take_screenshot`; on Linux via grim/spectacle, on Windows via `mss`).
- Feed the image straight to a vision brain — **`ApiBrain` already sends images** to the
  model (Mistral/OpenAI/Anthropic vision), so the plumbing exists.
- Show the answer in a small floating popup near the cursor (reuse the widget/overlay UI).
- Linux first (Sway keybind like the existing `$mod+j`), then Windows (a `RegisterHotKey`
  global hotkey in the Win32 shell).

---

## The backlog

### 1. 🔮 Proactive mode — it notices things on its own
Today Orin is reactive (you ask, it acts). Proactive mode watches your day and jumps in:
*"your build finished," "meeting in 5, here's the doc," "this email needs a reply — draft it?"*
Turns a tool-you-summon into a co-worker watching your back. (Builds on scheduler + hooks +
background jobs + the existing digest.)

### 2. ⌨️ "What's on my screen?" hotkey — *(starting now, see above)*

### 3. 🌙 Overnight autopilot
Hand it a big goal before bed (*"research X and write a report," "sort these 500 files"*); it
grinds all night with subagents + background jobs and hands you a finished result + summary in
the morning. The engine already has `bg_start`/`monitor`/`wake_me_in` + subagents — this is the
friendly packaging (checkpoints, progress, a morning report).

### 4. 🔒 Fully offline / local brain
Make a local LLM (Ollama is already an `ApiBrain` option) a **first-class** brain: free,
private, works with no internet and no API bill. Big for privacy + cost-sensitive users.

### 5. 🧠 Personal "second brain" (search your own stuff)
Point it at your files/notes/screenshots; ask *"where's that thing about…?"* It remembers
everything so you don't have to. A local knowledge base / RAG over your own life, wired into
the existing memory system.

### 6. 🎨 Generate images / video / music (not just widgets)
*"Make me a logo," "turn this into a 30-sec clip," "generate a jingle."* It renders UI widgets
today; real creative output is a natural, high-delight next step.

### 7. 📷 Live camera vision
Point your phone at something — *"what's wrong with this outlet?", "translate this menu," "is
this plant dying?"* — and it sees it live and answers. Photos already work; live camera is the
next step (Android app + engine).

### 8. 🔗 AI automations ("when this → do that")
A friendly recipe builder: *"when I get an email from my boss → text me + draft a reply."* Like
IFTTT/Zapier but with a brain, running locally. Builds on hooks + the scheduler.

---

## Ranking (subjective)
1. **Proactive mode** + **screen hotkey** — make it feel like real Orin.
2. **Overnight autopilot** — the "wow, it did my work while I slept" moment.
3. **Local brain** + **second brain** — privacy/cost + memory that compounds.
4. **Creative output**, **camera vision**, **automations** — big-delight, more work.
