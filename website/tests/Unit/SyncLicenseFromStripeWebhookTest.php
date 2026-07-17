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

    private function subscriptionCreatedPayload(string $customerId, string $subscriptionId, ?string $priceId = 'price_pro_test', string $status = 'active'): array
    {
        return [
            'type' => 'customer.subscription.created',
            'data' => [
                'object' => [
                    'id' => $subscriptionId,
                    'customer' => $customerId,
                    'status' => $status,
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

    public function test_does_not_grant_an_active_license_for_a_non_active_subscription_status(): void
    {
        // Codex review (PR #130): created/updated events used to unconditionally
        // set status="active" regardless of Stripe's own subscription status —
        // an incomplete/past_due/unpaid/paused subscription (failed or unfinished
        // payment) kept granting a valid paid-tier license.
        $user = User::factory()->create(['stripe_id' => 'cus_7']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_7', 'sub_7', 'price_pro_test', 'past_due')
        ));

        $license = License::where('stripe_subscription_id', 'sub_7')->firstOrFail();
        $this->assertSame('suspended', $license->status);
        $this->assertFalse($license->isCurrentlyValid());
    }

    public function test_marks_license_expired_for_a_canceled_subscription_status(): void
    {
        $user = User::factory()->create(['stripe_id' => 'cus_9']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_9', 'sub_9', 'price_pro_test', 'canceled')
        ));

        $license = License::where('stripe_subscription_id', 'sub_9')->firstOrFail();
        $this->assertSame('expired', $license->status);
        $this->assertFalse($license->isCurrentlyValid());
    }

    public function test_treats_trialing_subscription_status_as_active(): void
    {
        $user = User::factory()->create(['stripe_id' => 'cus_8']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_8', 'sub_8', 'price_pro_test', 'trialing')
        ));

        $license = License::where('stripe_subscription_id', 'sub_8')->firstOrFail();
        $this->assertSame('active', $license->status);
        $this->assertTrue($license->isCurrentlyValid());
    }

    public function test_does_not_overwrite_a_manually_issued_non_trial_license(): void
    {
        // Codex review (PR #130): the upgrade-in-place fallback used to match
        // ANY active no-subscription license, including a manually issued one
        // (e.g. a Filament-created lifetime enterprise grant) — buying an
        // unrelated subscription would overwrite and eventually expire it.
        $user = User::factory()->create(['stripe_id' => 'cus_10']);
        $manualLicense = $user->licenses()->create([
            'key' => 'CIND-MANUAL-0000-0001',
            'tier' => 'enterprise',
            'status' => 'active',
            'issued_at' => now(),
        ]);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_10', 'sub_10')
        ));

        $this->assertSame(2, $user->licenses()->count());
        $manualLicense->refresh();
        $this->assertSame('enterprise', $manualLicense->tier);
        $this->assertNull($manualLicense->stripe_subscription_id);
        $newLicense = License::where('stripe_subscription_id', 'sub_10')->firstOrFail();
        $this->assertSame('pro', $newLicense->tier);
    }

    public function test_does_not_grant_founding_member_status_for_a_non_active_subscription(): void
    {
        // Codex review (PR #130): this used to run for every recognized event,
        // so an abandoned/failed checkout (mapped to "suspended") consumed a
        // founding-member slot, excluding a later paying customer.
        $user = User::factory()->create(['stripe_id' => 'cus_11']);

        (new SyncLicenseFromStripeWebhook)->handle(new WebhookHandled(
            $this->subscriptionCreatedPayload('cus_11', 'sub_11', 'price_pro_test', 'past_due')
        ));

        $this->assertFalse($user->fresh()->is_founding_member);
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
