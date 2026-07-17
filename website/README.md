# Cindro website (`website/`)

The marketing/billing site for Cindro, per [`sell.md`](../sell.md)'s "Laravel plan" section.
Laravel 13 + Breeze (Blade auth) + Cashier (Stripe billing) + Filament (internal admin) +
Tailwind, styled with a "hacker meets macOS" dark theme (terminal-window chrome, monospace
accents). This is a self-contained project — its own `composer.json`/`package.json` — with no
CMake integration, same as `web/`, `android/`, `computer-use/`.

**Note on Laravel version:** sell.md specified Laravel 11, but by the time this was built every
recent Laravel 11.x patch release had unpatched security advisories (Composer blocks installing
them). This scaffold uses the current stable major (Laravel 13) instead — same stack, same
pages, just not pinned to an EOL version.

## Local setup

```bash
cd website
composer install
npm install
cp .env.example .env
php artisan key:generate
php artisan migrate:fresh --seed   # creates a demo admin + one sample user per tier
npm run build                      # or `npm run dev` for the Vite dev server
php artisan serve
```

Seeded logins (see `database/seeders/DatabaseSeeder.php`): `admin@cindro.test`,
`trial@cindro.test`, `starter@cindro.test`, `pro@cindro.test`, `business@cindro.test` — all
share the factory-default password (`password`). The Filament admin panel is at `/admin`.

Run the test suite with `php artisan test` (uses an in-memory sqlite DB, no setup needed).

## Pages

| Route | What it is |
|---|---|
| `/` | Marketing landing page |
| `/pricing` | Tier comparison, driven by `app/Support/PricingCatalog.php` |
| `/download` | Platform picker, pulls the latest GitHub Release |
| `/register`, `/login` | Breeze auth — registering starts the 14-day trial (no Stripe involved) |
| `/dashboard` | Subscription status, license key(s), phone-number usage, billing portal, gated downloads |
| `/terms`, `/privacy` | Placeholder legal pages, marked "pending legal review" |
| `POST /api/license/verify` | JSON API — see below |
| `/admin` | Filament admin (Users, Licenses, manual license issuance) |

## `/api/license/verify` contract

The one real integration point back into the main Cindro product. Documented in a doc-comment on
`app/Http/Controllers/Api/LicenseVerifyController.php`; summarized here for convenience. A future
`core/` `LicenseStore` (mirroring the existing `SettingsStore` pattern) is meant to consume this —
**no `core/` changes were made as part of building this site.**

Request:
```
POST /api/license/verify
{ "license_key": "CIND-AB12-CD34-EF56", "device_id": "optional-opaque-id" }
```

Valid (HTTP 200):
```json
{ "valid": true, "tier": "pro", "status": "active", "expires_at": "2026-08-01T00:00:00Z",
  "seats": 1, "features": { "hosted_phone_number": true, "...": "..." }, "checked_at": "..." }
```

Invalid (still HTTP 200 — a clean "no/expired/revoked" answer is a normal, cacheable result, not
a transport error):
```json
{ "valid": false, "reason": "not_found" }
```
(`reason` is one of `not_found`, `expired`, `revoked`, `suspended`.) Only genuine network/5xx
failures should read as "verification unavailable" on the daemon side — that's what lets a future
offline fallback distinguish "definitely invalid" from "couldn't check."

## Known limitations

This is a structurally complete scaffold, not a production billing system. Several pieces are
code-complete but **not live-testable in this environment**, and several of sell.md's own open
questions are deliberately left unresolved rather than guessed at:

- **Stripe billing** — Cashier/Checkout/webhook wiring is real code, but `.env` only has
  placeholder Stripe keys (`STRIPE_KEY`, `STRIPE_SECRET`, `STRIPE_PRICE_*`). Drop in real
  test-mode keys to exercise the checkout flow end-to-end.
- **GitHub Releases API** — `/download` calls the real API via `GitHubReleaseService`, but the
  product repo is **private**, so it needs a real `GITHUB_TOKEN` to return anything; without one
  it falls back to a static "see GitHub Releases directly" link (this is what's actually exercised
  in this environment).
- **Private-repo download links** — even with a token, the *asset* URLs GitHub returns aren't
  anonymously downloadable while the repo stays private — a logged-out visitor hits GitHub's auth
  wall. Either the repo goes public before launch, or a `/download/proxy/{platform}` route needs
  to be built to stream the bytes server-side (flagged as a `// TODO` in `GitHubReleaseService`).
  Not solved in this pass.
- **Twilio / hosted phone numbers** — modeled structurally (a `phone_numbers` table + dashboard
  UI showing usage against caps), but "request a number" only creates a `pending` DB row — no real
  telephony provider is wired up (sell.md lists the Twilio account strategy as an open question).
- **Founding Member coupon** — the 50%-off-for-life gate is coded (`config('cindro.founding_member_coupon')`),
  but the actual Stripe coupon/promo code ID needs a real Stripe dashboard.
- **Terms of Service / Privacy Policy** — placeholder content only, explicitly marked "pending
  legal review" per sell.md's open question — not real legal copy.
- **Pricing/trial numbers** — transcribed verbatim from sell.md's tables, which are themselves
  marked as proposals, not commitments.
