<?php

return [
    'trial_days' => 14,
    'founding_member_cap' => 100,

    'tiers' => [
        'trial' => [
            'label' => 'Free Trial',
            'monthly' => 0,
            'stripe_price' => null,
        ],
        'starter' => [
            'label' => 'Starter',
            'monthly' => 15,
            'stripe_price' => env('STRIPE_PRICE_STARTER'),
        ],
        'pro' => [
            'label' => 'Pro',
            'monthly' => 35,
            'stripe_price' => env('STRIPE_PRICE_PRO'),
        ],
        'business' => [
            'label' => 'Business',
            'monthly' => 69,
            'stripe_price' => env('STRIPE_PRICE_BUSINESS'),
            'per_seat' => true,
            'min_seats' => 3,
        ],
        'enterprise' => [
            'label' => 'Enterprise',
            'monthly' => null, // "custom" — no self-serve Stripe price, always routes to contact sales
            'stripe_price' => null,
        ],
    ],

    // Stripe coupon/promotion code applied while founding_member_cap hasn't been reached yet.
    // Real ID needs a live Stripe dashboard — see sell.md's open questions.
    'founding_member_coupon' => env('STRIPE_FOUNDING_MEMBER_COUPON'),
];
