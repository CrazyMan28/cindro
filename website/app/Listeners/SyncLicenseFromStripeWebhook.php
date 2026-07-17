<?php

namespace App\Listeners;

use App\Models\License;
use App\Models\User;
use App\Services\LicenseKeyGenerator;
use Carbon\CarbonImmutable;
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

        // Codex review (PR #130): Stripe webhook delivery is not guaranteed to
        // preserve event order. Every branch below overwrites the license's
        // status unconditionally — a delayed pre-cancellation `updated` event
        // arriving AFTER `deleted` used to reactivate a just-expired license.
        // Stamp every applied event's own Stripe-assigned timestamp
        // (event.created, unix seconds — NOT a local clock) on the license
        // and refuse to apply one older than what's already recorded there.
        $eventCreatedAt = isset($event->payload['created'])
            ? CarbonImmutable::createFromTimestampUTC((int) $event->payload['created'])
            : null;
        $isStale = static fn (?License $license): bool => $license !== null
            && $eventCreatedAt !== null
            && $license->last_stripe_event_at !== null
            && $eventCreatedAt->lessThan($license->last_stripe_event_at);

        if ($type === 'customer.subscription.deleted') {
            $existing = License::where('stripe_subscription_id', $stripeSubscriptionId)->first();
            if ($isStale($existing)) {
                return;
            }
            License::where('stripe_subscription_id', $stripeSubscriptionId)
                ->update(['status' => 'expired', 'last_stripe_event_at' => $eventCreatedAt]);

            return;
        }

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

        $priceId = $subscription['items']['data'][0]['price']['id'] ?? null;

        // Guard explicitly against a missing price id — several tiers (trial,
        // enterprise) have a null `stripe_price` in config, so a null $priceId
        // would otherwise match the first of those via search() and silently
        // mis-tier a real paid subscription.
        $tier = $priceId !== null
            ? collect(config('cindro.tiers'))
                ->search(fn ($config) => $config['stripe_price'] !== null && $config['stripe_price'] === $priceId)
            : false;

        if ($tier === false) {
            // Codex review (PR #130): a null/unrecognized price (an archived
            // or rotated Stripe Price, or a tier with no stripe_price like
            // trial/enterprise) used to return here UNCONDITIONALLY — even for
            // an EXISTING license, so a later past_due/unpaid webhook for that
            // now-unrecognized price left the license "active" indefinitely.
            // Still sync STATUS (retaining the current tier, which we can't
            // redetermine here) for a subscription we already track; only
            // skip entirely for one we've genuinely never seen.
            $existing = License::where('stripe_subscription_id', $stripeSubscriptionId)->first();
            if ($existing && ! $isStale($existing)) {
                $existing->update(['status' => $status, 'last_stripe_event_at' => $eventCreatedAt]);
            }

            return;
        }

        $seats = $subscription['items']['data'][0]['quantity'] ?? 1;

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

        if ($isStale($license)) {
            return;
        }

        if ($license) {
            $license->update([
                'stripe_subscription_id' => $stripeSubscriptionId,
                'tier' => $tier,
                'status' => $status,
                'seats' => $seats,
                // Codex review (PR #130): upgrading a trial (or re-syncing any
                // existing license) left its ORIGINAL expires_at intact —
                // once that date passed, License::invalidReason() read
                // "expired" even though Stripe still reported the
                // subscription active. A Stripe-backed license's validity
                // comes from `status` (kept current by later webhooks), never
                // a fixed expiry.
                'expires_at' => null,
                'last_stripe_event_at' => $eventCreatedAt,
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
                'last_stripe_event_at' => $eventCreatedAt,
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
