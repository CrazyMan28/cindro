<?php

namespace App\Listeners;

use App\Models\License;
use App\Models\User;
use App\Services\LicenseKeyGenerator;
use Illuminate\Database\QueryException;
use Laravel\Cashier\Events\WebhookHandled;

/**
 * Keeps the local `licenses` table (what /api/license/verify actually reads) in
 * sync with Stripe subscription state. This is the one piece of real business
 * logic tying billing to licensing — Cashier's own subscriptions table is the
 * source of truth for billing, this listener projects it into the simpler
 * License model a future core/ LicenseStore is meant to consume.
 */
class SyncLicenseFromStripeWebhook
{
    private const HANDLED_TYPES = [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
    ];

    public function handle(WebhookHandled $event): void
    {
        $type = $event->payload['type'] ?? null;

        if (! in_array($type, self::HANDLED_TYPES, true)) {
            return;
        }

        $subscription = $event->payload['data']['object'] ?? null;
        $stripeCustomerId = $subscription['customer'] ?? null;
        $stripeSubscriptionId = $subscription['id'] ?? null;

        if (! $stripeCustomerId || ! $stripeSubscriptionId) {
            return;
        }

        $user = User::where('stripe_id', $stripeCustomerId)->first();

        if (! $user) {
            return;
        }

        if ($type === 'customer.subscription.deleted') {
            License::where('stripe_subscription_id', $stripeSubscriptionId)
                ->update(['status' => 'expired']);

            return;
        }

        $priceId = $subscription['items']['data'][0]['price']['id'] ?? null;

        // Guard explicitly against a missing price id — several tiers (trial,
        // enterprise) have a null `stripe_price` in config, so a null $priceId
        // would otherwise match the first of those via search() and silently
        // mis-tier a real paid subscription.
        if ($priceId === null) {
            return;
        }

        $tier = collect(config('cindro.tiers'))
            ->search(fn ($config) => $config['stripe_price'] !== null && $config['stripe_price'] === $priceId);

        if ($tier === false) {
            return;
        }

        $seats = $subscription['items']['data'][0]['quantity'] ?? 1;

        $license = License::where('stripe_subscription_id', $stripeSubscriptionId)->first()
            // A user who registered already has a trial (or manually-issued)
            // license with no stripe_subscription_id — upgrade that one in
            // place instead of leaving it active alongside a second row.
            ?? $user->licenses()->whereNull('stripe_subscription_id')->where('status', 'active')->first();

        if ($license) {
            $license->update([
                'stripe_subscription_id' => $stripeSubscriptionId,
                'tier' => $tier,
                'status' => 'active',
                'seats' => $seats,
            ]);
        } else {
            retry(3, fn () => License::create([
                'user_id' => $user->id,
                'key' => LicenseKeyGenerator::generate(),
                'stripe_subscription_id' => $stripeSubscriptionId,
                'tier' => $tier,
                'status' => 'active',
                'seats' => $seats,
                'issued_at' => now(),
                'expires_at' => null,
            ]), 0, fn (\Throwable $e) => $e instanceof QueryException);
        }

        $user->grantFoundingMemberStatusIfSlotAvailable();
    }
}
