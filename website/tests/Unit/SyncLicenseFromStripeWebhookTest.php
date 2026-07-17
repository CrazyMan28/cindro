<?php

namespace Tests\Unit;

use App\Listeners\SyncLicenseFromStripeWebhook;
use App\Models\License;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Cashier\Events\WebhookHandled;
use Tests\TestCase;

class SyncLicenseFromStripeWebhookTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'cindro.tiers.pro.stripe_price' => 'price_pro_test',
            'cindro.founding_member_cap' => 2,
        ]);
    }

    private function subscriptionCreatedPayload(string $customerId, string $subscriptionId, ?string $priceId = 'price_pro_test'): array
    {
        return [
            'type' => 'customer.subscription.created',
            'data' => [
                'object' => [
                    'id' => $subscriptionId,
                    'customer' => $customerId,
                    'items' => ['data' => [['price' => ['id' => $priceId]]]],
                ],
            ],
        ];
    }

    public function test_creates_a_license_and_grants_founding_member_status(): void
    {
        $user = User::factory()->create(['stripe_id' => 'cus_1']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_1', 'sub_1')
        ));

        $license = License::where('stripe_subscription_id', 'sub_1')->firstOrFail();
        $this->assertSame('pro', $license->tier);
        $this->assertSame('active', $license->status);
        $this->assertTrue($user->fresh()->is_founding_member);
        $this->assertSame(1, $user->fresh()->founding_member_number);
    }

    public function test_upgrades_existing_trial_license_instead_of_creating_a_duplicate(): void
    {
        $user = User::factory()->create(['stripe_id' => 'cus_2']);
        $trialLicense = $user->licenses()->create([
            'key' => 'CIND-TRIAL-0000-0001',
            'tier' => 'trial',
            'status' => 'active',
            'issued_at' => now(),
            'expires_at' => now()->addDays(14),
        ]);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_2', 'sub_2')
        ));

        $this->assertSame(1, $user->licenses()->count());
        $trialLicense->refresh();
        $this->assertSame('pro', $trialLicense->tier);
        $this->assertSame('sub_2', $trialLicense->stripe_subscription_id);
    }

    public function test_ignores_webhook_when_price_id_does_not_match_any_tier(): void
    {
        User::factory()->create(['stripe_id' => 'cus_3']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_3', 'sub_3', 'price_unknown')
        ));

        $this->assertSame(0, License::count());
    }

    public function test_ignores_webhook_when_price_id_is_missing_rather_than_defaulting_to_trial(): void
    {
        User::factory()->create(['stripe_id' => 'cus_4']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_4', 'sub_4', null)
        ));

        $this->assertSame(0, License::count());
    }

    public function test_marks_license_expired_on_subscription_deleted(): void
    {
        $user = User::factory()->create(['stripe_id' => 'cus_5']);
        $user->licenses()->create([
            'key' => 'CIND-DEL-0000-0001',
            'tier' => 'pro',
            'status' => 'active',
            'stripe_subscription_id' => 'sub_5',
            'issued_at' => now(),
        ]);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled([
            'type' => 'customer.subscription.deleted',
            'data' => ['object' => ['id' => 'sub_5', 'customer' => 'cus_5']],
        ]));

        $this->assertSame('expired', License::where('stripe_subscription_id', 'sub_5')->firstOrFail()->status);
    }

    public function test_stops_granting_founding_member_status_once_cap_is_reached(): void
    {
        User::factory()->count(2)->create(['is_founding_member' => true]);
        $user = User::factory()->create(['stripe_id' => 'cus_6']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_6', 'sub_6')
        ));

        $this->assertFalse($user->fresh()->is_founding_member);
    }
}
