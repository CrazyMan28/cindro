<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class CheckoutController extends Controller
{
    /**
     * Redirect to Stripe-hosted Checkout for a self-serve tier. Enterprise has no
     * Stripe price (always "contact sales"); trial has no billing step at all.
     */
    public function subscribe(Request $request, string $tier): Response
    {
        $config = config("cindro.tiers.{$tier}");

        abort_unless($config && ($config['stripe_price'] ?? null), 404);

        $user = $request->user();

        // Codex review (PR #130): this always started a brand-new Stripe
        // Checkout session even when the user already has an active "default"
        // subscription — the pricing page stays reachable and the
        // subscriptions table doesn't enforce one row per user/type, so a
        // repeat visit (or picking a different tier) could complete a SECOND
        // concurrent subscription and double-bill them. Send an
        // already-subscribed user to the billing portal (swap/cancel there)
        // instead of starting another checkout.
        if ($user->subscribed('default')) {
            return redirect()->route('billing-portal');
        }

        $seats = (int) $request->integer('seats', $config['min_seats'] ?? 1);

        if ($config['per_seat'] ?? false) {
            $seats = max($seats, $config['min_seats'] ?? 1);
        }

        $checkoutOptions = [
            'success_url' => route('dashboard'),
            'cancel_url' => route('pricing'),
        ];

        $foundingCoupon = config('cindro.founding_member_coupon');

        if ($foundingCoupon && User::foundingMembersClaimedCount() < config('cindro.founding_member_cap')) {
            $checkoutOptions['discounts'] = [['coupon' => $foundingCoupon]];
        }

        $subscriptionBuilder = $user->newSubscription('default', $config['stripe_price']);

        if ($config['per_seat'] ?? false) {
            $subscriptionBuilder->quantity($seats);
        }

        return $subscriptionBuilder->checkout($checkoutOptions);
    }
}
