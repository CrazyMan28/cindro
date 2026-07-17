<?php

namespace App\Support;

/**
 * Single source of truth for the tier/feature matrix transcribed from sell.md.
 * Consumed by the /pricing view, the landing page's feature cards, and
 * /api/license/verify's "features" response — copy and gating flags live here once,
 * not duplicated across views and controllers.
 */
class PricingCatalog
{
    /** @var list<string> */
    public const TIERS = ['trial', 'starter', 'pro', 'business', 'enterprise'];

    /** @var list<string> */
    public const LICENSE_STATUSES = ['active', 'suspended', 'revoked', 'expired'];

    /**
     * Tier key => display label, for Filament Select components. Sourced from
     * config('cindro.tiers') — the single source of truth for tier labels —
     * so admin dropdowns can never drift from the tiers config defines.
     *
     * @return array<string, string>
     */
    public static function tierSelectOptions(): array
    {
        return collect(config('cindro.tiers'))->map(fn ($tier) => $tier['label'])->all();
    }

    /** @return array<string, string> */
    public static function licenseStatusSelectOptions(): array
    {
        return collect(self::LICENSE_STATUSES)->mapWithKeys(fn ($status) => [$status => ucfirst($status)])->all();
    }

    /**
     * Full comparison-table rows, in display order. Each row has a label and a
     * per-tier cell. Cells are either `true`/`false` (rendered as a check/dash)
     * or a string for rows whose value differs in kind across tiers (seats,
     * phone number allowance, support level, etc).
     *
     * @return list<array{key: string, label: string, trial: bool|string, starter: bool|string, pro: bool|string, business: bool|string, enterprise: bool|string}>
     */
    public static function featureRows(): array
    {
        return [
            ['key' => 'desktop_app', 'label' => 'Desktop app (Linux, Windows)', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'android_chrome', 'label' => 'Android + Chrome extension', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'iphone_beta', 'label' => 'iPhone (beta)', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'computer_use', 'label' => 'Computer-use (drives mouse/keyboard/screen)', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'chat_memory_scheduler', 'label' => 'Chat, memory, scheduler, durable work queue', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'generative_widgets', 'label' => 'Generative widgets / live canvases', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'trust_policies', 'label' => 'Trust policies, biometric unlock, command scanner', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'editor_integration', 'label' => 'Editor integration (Zed / JetBrains via ACP)', 'trial' => true, 'starter' => true, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'byo_ai_key', 'label' => 'Bring your own AI provider key', 'trial' => 'required (or $5 credit)', 'starter' => 'required', 'pro' => 'required', 'business' => 'required', 'enterprise' => 'required'],
            ['key' => 'workspaces', 'label' => 'Workspaces / seats', 'trial' => '1', 'starter' => '1', 'pro' => '1', 'business' => '3 minimum, per seat', 'enterprise' => 'custom'],
            ['key' => 'hosted_phone_number', 'label' => 'Hosted phone number (calls + SMS)', 'trial' => '1 number, capped (30 min / 100 SMS)', 'starter' => 'not included — BYO Twilio only', 'pro' => 'included, pooled minutes', 'business' => 'included per seat', 'enterprise' => 'custom volume'],
            ['key' => 'cloned_voice', 'label' => 'Cloned voice', 'trial' => 'preview (5 generations)', 'starter' => 'not included', 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'hosted_pairing_relay', 'label' => 'Hosted pairing relay (no network config needed)', 'trial' => true, 'starter' => 'not included — self-configure tailnet/port-forward', 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'proxmox_agent', 'label' => 'Proxmox / infra workload-manager agent', 'trial' => false, 'starter' => false, 'pro' => false, 'business' => true, 'enterprise' => true],
            ['key' => 'shared_team_memory', 'label' => 'Shared team memory & skills', 'trial' => false, 'starter' => false, 'pro' => false, 'business' => true, 'enterprise' => true],
            ['key' => 'sso', 'label' => 'SSO, centralized admin & audit log', 'trial' => false, 'starter' => false, 'pro' => false, 'business' => true, 'enterprise' => true],
            ['key' => 'early_access', 'label' => 'Early access to new surfaces', 'trial' => false, 'starter' => false, 'pro' => true, 'business' => true, 'enterprise' => true],
            ['key' => 'support', 'label' => 'Support', 'trial' => 'community Discord', 'starter' => 'community Discord', 'pro' => 'priority email, 24h', 'business' => 'dedicated support channel', 'enterprise' => 'dedicated engineer, custom SLA'],
        ];
    }

    /**
     * The subset of feature rows that are genuinely boolean gates (used to build
     * /api/license/verify's "features" map — rows with tier-varying string values
     * like "workspaces" or "support" aren't feature flags a client can gate on).
     *
     * @return array<string, bool>
     */
    public static function booleanFeatureFlags(string $tier): array
    {
        $booleanKeys = [
            'computer_use', 'generative_widgets', 'trust_policies', 'editor_integration',
            'hosted_phone_number', 'cloned_voice', 'hosted_pairing_relay',
            'proxmox_agent', 'shared_team_memory', 'sso', 'early_access',
        ];

        $flags = [];

        foreach (self::featureRows() as $row) {
            if (! in_array($row['key'], $booleanKeys, true)) {
                continue;
            }

            // Codex review (PR #130): every string value used to flag `true`
            // unconditionally, including explicit exclusions like Starter's
            // cloned_voice "not included" and hosted_pairing_relay "not
            // included — self-configure tailnet/port-forward" — so
            // /api/license/verify told a Starter client those features WERE
            // available, contradicting the pricing table it's meant to
            // mirror. Every "not included" string in this catalog uses that
            // exact prefix; any OTHER string describes an available feature
            // with a caveat/limit (e.g. trial's "preview (5 generations)").
            $value = $row[$tier] ?? false;
            $flags[$row['key']] = is_string($value)
                ? ! str_starts_with($value, 'not included')
                : (bool) $value;
        }

        return $flags;
    }

    /**
     * The 8 marketing bullets for the landing page, verbatim from sell.md's
     * "What's out of the box" section.
     *
     * @return list<array{title: string, description: string}>
     */
    public static function marketingBullets(): array
    {
        return [
            ['title' => 'Computer use', 'description' => 'Pixel-accurate mouse/keyboard/screen control, on its own private nested desktop by default, or a visible takeover of the real screen on request.'],
            ['title' => 'Cross-device', 'description' => 'One brain, same sessions/memory/permissions across desktop, Android, Chrome, iPhone (beta).'],
            ['title' => 'Voice', 'description' => 'Hands-free voice mode both directions; cloned voice on calls (Pro+).'],
            ['title' => 'Memory & scheduling', 'description' => 'Persistent context, cron/natural-language scheduling, an overnight work queue that survives restarts.'],
            ['title' => 'Security', 'description' => 'Per-tool trust rules (allow/ask/deny), a pre-execution shell command scanner, cross-device biometric unlock.'],
            ['title' => 'Live widgets', 'description' => 'On-the-fly charts, checklists, and interactive quizzes, pinned to a home screen or desktop.'],
            ['title' => 'Reliability', 'description' => 'Self-healing retries on failed clicks, a low-noise anomaly watcher, full session replay.'],
            ['title' => 'Editor integration', 'description' => 'A native Agent Client Protocol agent inside Zed / JetBrains.'],
        ];
    }
}
