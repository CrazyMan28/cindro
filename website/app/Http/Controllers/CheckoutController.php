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
