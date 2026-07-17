<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CheckoutTest extends TestCase
{
    use RefreshDatabase;

    public function test_redirects_already_subscribed_users_to_the_billing_portal(): void
    {
        // Codex review (PR #130): subscribe() used to always start a brand-new
        // Stripe Checkout session even for a user who already has an active
        // "default" subscription — repeating checkout (or picking another
        // tier) could complete a second concurrent subscription and double-bill
        // them. Send them to the billing portal instead.
        config(['cindro.tiers.pro.stripe_price' => 'price_pro_test']);
        $user = User::factory()->create(['stripe_id' => 'cus_checkout_1']);
        $user->subscriptions()->create([
            'type' => 'default',
            'stripe_id' => 'sub_checkout_1',
            'stripe_status' => 'active',
            'stripe_price' => 'price_pro_test',
            'quantity' => 1,
        ]);

        $response = $this->actingAs($user)->get('/checkout/pro');

        $response->assertRedirect(route('billing-portal'));
    }
}
