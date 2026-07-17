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

        // Codex review (PR #130): this used to unconditionally set status to
        // "active" for BOTH created and updated events, so a subscription
        // Stripe reports as incomplete/past_due/unpaid/paused kept granting a
        // valid paid-tier license until a later deletion event happened to
        // arrive. Derive it from Stripe's own subscription status instead.
        // The `status` column is a DB-level enum (active|suspended|revoked|
        // expired — see the licenses migration), so Stripe's own status
        // strings (which don't match that set) must be MAPPED, not passed
        // through verbatim, or the update/insert itself would fail.
        $status = match ($subscription['status'] ?? null) {
            'active', 'trialing' => 'active',
            'canceled', 'incomplete_expired' => 'expired',
            // past_due/unpaid (payment failing), incomplete (first payment
            // not yet confirmed), paused (intentionally on hold) — none of
            // these are a hard "it's over" like a full cancellation, but none
            // should grant access either.
            default => 'suspended',
        };

        $license = License::where('stripe_subscription_id', $stripeSubscriptionId)->first()
            // A user who registered already has a TRIAL license with no
            // stripe_subscription_id — upgrade that one in place instead of
            // leaving it active alongside a second row. Codex review (PR
            // #130): this used to match ANY active no-subscription license,
            // including a manually-issued one (e.g. a Filament-created
            // lifetime enterprise grant) — buying and later canceling an
            // unrelated Starter subscription would overwrite and eventually
            // expire that manual license. Scoped to tier=trial, the only kind
            // Stripe is ever meant to upgrade in place.
            ?? $user->licenses()->whereNull('stripe_subscription_id')
                ->where('status', 'active')->where('tier', 'trial')->first();

        if ($license) {
            $license->update([
                'stripe_subscription_id' => $stripeSubscriptionId,
                'tier' => $tier,
                'status' => $status,
                'seats' => $seats,
            ]);
        } else {
            retry(3, fn () => License::create([
                'user_id' => $user->id,
                'key' => LicenseKeyGenerator::generate(),
                'stripe_subscription_id' => $stripeSubscriptionId,
                'tier' => $tier,
                'status' => $status,
                'seats' => $seats,
                'issued_at' => now(),
                'expires_at' => null,
            ]), 0, fn (\Throwable $e) => $e instanceof QueryException);
        }

        // Codex review (PR #130): this used to run for EVERY recognized event,
        // including incomplete/past_due/unpaid/paused ones mapped to
        // "suspended" above — an abandoned or failed checkout consumed a
        // founding-member slot, excluding a later paying customer. Only grant
        // it once the subscription is actually active.
        if ($status === 'active') {
            $user->grantFoundingMemberStatusIfSlotAvailable();
        }
    }
}
