# Selling Cindro — go-to-market plan

_Working doc — pricing, trial mechanics, and positioning are proposals, not commitments. Review before wiring up real billing._

## Can we sell it? Would people use it?

**Yes, with a caveat on who "people" are.** The repo is private, so this is ordinary paid-software
territory — subscriptions and license keys, no open-source-licensing complication to solve first.

The product is genuinely differentiated: nothing else on the market bundles real computer-use
automation (mouse/keyboard/screen control) with cross-device reach (desktop, Android, Chrome,
iPhone) *and* an actual phone number that calls/texts you back, in one local-first package.

The honest limit is platform maturity, not the pitch: Linux (KDE/Sway) is the first-class
experience, Windows is explicitly "second-tier/experimental," there's no macOS build, and
`docs/STATUS.md` still lists recent features as "not yet verified end-to-end." That means the
realistic early customer is **technical people who already run their own infrastructure** —
solo devs, homelabbers, small ops/dev teams running Proxmox or self-hosted stacks — not a general
consumer audience yet. Price and position for that audience first; expand once Windows support and
macOS close the gap.

## Target market

| Segment | Fit today | Why |
|---|---|---|
| Solo devs / power users | **Yes** | Already comfortable with Linux, terminals, self-hosting; want an agent that acts, not just chats. |
| Homelabbers / small ops teams | **Yes** | Already run Proxmox or self-hosted infra; the workload-manager agent is a direct wedge (watches/tunes VMs unattended). |
| Non-technical consumers | **Not yet** | No macOS, Windows still experimental, small support team — don't oversell past what the product can back up. |

## Monetization model

Standard SaaS: tiered subscriptions, billed monthly or annually (~20% discount annual), with the
paid tiers monetizing the things that are genuinely painful to self-host — a provisioned phone
number, a pairing relay that works without manual network configuration, and multi-seat team
features (shared memory, SSO, audit log) — rather than gating the core agent behind a paywall.

**Founding Member offer:** the first 100 customers get 50% off for life. This is deliberate, not
just a discount gimmick — it's the honest trade for joining while the product is still fixing
rough edges, and it turns early bug tolerance into a badge instead of a complaint.

## Free trial — 14 days, no credit card required

The trial grants **full Pro-tier access**, not a stripped-down Starter preview — the phone number,
cloned voice, and hosted relay are the features most likely to make someone say "I need this,"
and a trial that hides them undersells the product. Usage is capped to keep trial-abuse cost
bounded, not to hide capability:

- **1 workspace** (desktop + phone + Chrome as one paired set). Business-tier features (SSO,
  shared team memory, the Proxmox agent) are excluded from the trial — they need a real team/infra
  context to evaluate and are a separate, higher-touch sales motion.
- **1 hosted phone number**, capped at 30 call minutes / 100 SMS — enough to genuinely test
  "it answers my calls and texts me back," not enough to run it as a free line.
- **Cloned voice**: preview only, capped at 5 generations.
- **Hosted pairing relay**: fully included (zero cost to us, it's the strongest "wow, that just
  worked" moment).
- **$5 pooled LLM credit** for anyone without their own OpenAI/Anthropic/Mistral key, so the trial
  doesn't stall at "go set up a provider account first." Bring-your-own-key is otherwise required
  on every tier, trial included — Cindro doesn't want to carry token costs long-term.
- **Support**: community Discord only.

**At day 14**, if no plan is chosen: the account soft-locks (no new sessions), the hosted phone
number returns to the pool after a 3-day grace period, and all data (sessions, memory, skills)
stays retained read-only for 30 days so upgrading later loses nothing. No auto-charge, because no
card was collected.

## What each plan gets

| Feature | Free Trial (14d) | Starter — $15/mo | Pro — $35/mo | Business — $69/seat/mo (3-seat min) | Enterprise — custom |
|---|---|---|---|---|---|
| Desktop app (Linux, Windows) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Android + Chrome extension | ✓ | ✓ | ✓ | ✓ | ✓ |
| iPhone (beta) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Computer-use (drives mouse/keyboard/screen) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Chat, memory, scheduler, durable work queue | ✓ | ✓ | ✓ | ✓ | ✓ |
| Generative widgets / live canvases | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trust policies, biometric unlock, command scanner | ✓ | ✓ | ✓ | ✓ | ✓ |
| Editor integration (Zed / JetBrains via ACP) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bring your own AI provider key | required (or $5 credit) | required | required | required | required |
| Workspaces / seats | 1 | 1 | 1 | 3 minimum, per seat | custom |
| Hosted phone number (calls + SMS) | 1 number, capped (30 min / 100 SMS) | not included — BYO Twilio only | included, pooled minutes | included per seat | custom volume |
| Cloned voice | preview (5 generations) | not included | ✓ | ✓ | ✓ |
| Hosted pairing relay (no network config needed) | ✓ | not included — self-configure tailnet/port-forward | ✓ | ✓ | ✓ |
| Proxmox / infra workload-manager agent | not included | not included | not included | ✓ | ✓ |
| Shared team memory & skills | not included | not included | not included | ✓ | ✓ |
| SSO, centralized admin & audit log | not included | not included | not included | ✓ | ✓ |
| Early access to new surfaces | not included | not included | ✓ | ✓ | ✓ |
| Support | community Discord | community Discord | priority email, 24h | dedicated support channel | dedicated engineer, custom SLA |

## What's "out of the box" (marketing copy, grounded in the actual feature set)

- **Computer use** — pixel-accurate mouse/keyboard/screen control, on its own private nested
  desktop by default, or a visible takeover of the real screen on request.
- **Cross-device** — one brain, same sessions/memory/permissions across desktop, Android, Chrome,
  iPhone (beta).
- **Voice** — hands-free voice mode both directions; cloned voice on calls (Pro+).
- **Memory & scheduling** — persistent context, cron/natural-language scheduling, an overnight
  work queue that survives restarts.
- **Security** — per-tool trust rules (allow/ask/deny), a pre-execution shell command scanner,
  cross-device biometric unlock.
- **Live widgets** — on-the-fly charts, checklists, and interactive quizzes, pinned to a home
  screen or desktop.
- **Reliability** — self-healing retries on failed clicks, a low-noise anomaly watcher, full
  session replay.
- **Editor integration** — a native Agent Client Protocol agent inside Zed / JetBrains.

## The front-end / sales site — Laravel plan

**Stack:** Laravel 11 + Breeze (auth) + Cashier/Stripe (billing) + Filament (internal admin — MRR,
customers, manual license issuance) + Tailwind (styled to match the landing/pricing mockup already
produced).

**Pages:**
- `/` — marketing landing page
- `/pricing` — tier comparison (the table above)
- `/download` — platform picker, pulling the latest release per platform from the GitHub Releases
  API
- `/register`, `/login` — Breeze auth
- `/dashboard` — subscription status, license key(s), phone number management (Pro+), invoices via
  Cashier's billing portal, gated download links
- `/api/license/verify` — the one real integration point back into this repo: the daemon needs a
  small `LicenseStore` (mirroring the existing `SettingsStore` pattern) that checks this endpoint
  and gates Pro-only features like the hosted relay and phone number, with a graceful offline
  fallback so a network hiccup doesn't lock someone out mid-session.

**Where it lives:** a new top-level `website/` directory in this repo (per team decision — kept in
the monorepo rather than a separate repo, despite the different stack/deploy target).

## Open questions before this becomes real

- Confirm final pricing/trial numbers (all figures above are proposals).
- Stripe account + legal entity for billing.
- Twilio account strategy for the hosted phone number pool (cost basis for Pro/Business margins).
- Terms of Service / privacy policy — especially around the phone/SMS features (carrier and
  regulatory compliance for calling/texting on a user's behalf).
- Decide the `LicenseStore` design in `core/` before `/api/license/verify` is load-bearing.
