<?php

namespace App\Filament\Widgets;

use App\Models\License;
use App\Support\PricingCatalog;
use Filament\Widgets\StatsOverviewWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;

/**
 * Scoped to local DB counts only, not a Stripe-derived MRR figure — the latter
 * isn't testable without live Stripe data, so this stays honestly scoped to
 * what this scaffold can actually prove.
 */
class LicensesByTierWidget extends StatsOverviewWidget
{
    protected function getStats(): array
    {
        $activeByTier = License::query()
            ->where('status', 'active')
            ->selectRaw('tier, count(*) as count')
            ->groupBy('tier')
            ->pluck('count', 'tier');

        return collect(PricingCatalog::TIERS)
            ->map(fn (string $tier) => Stat::make(ucfirst($tier), (string) ($activeByTier[$tier] ?? 0)))
            ->all();
    }
}
