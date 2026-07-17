<?php

namespace Tests\Feature;

use App\Models\License;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LicenseVerifyTest extends TestCase
{
    use RefreshDatabase;

    public function test_valid_license_returns_features(): void
    {
        $license = License::factory()->create(['tier' => 'pro', 'status' => 'active']);

        $response = $this->postJson('/api/license/verify', ['license_key' => $license->key]);

        $response->assertOk()->assertJson([
            'valid' => true,
            'tier' => 'pro',
            'status' => 'active',
        ]);
        $response->assertJsonStructure(['valid', 'tier', 'status', 'expires_at', 'seats', 'features', 'checked_at']);

        $this->assertNotNull($license->fresh()->last_verified_at);
    }

    public function test_unknown_key_returns_not_found(): void
    {
        $response = $this->postJson('/api/license/verify', ['license_key' => 'CIND-0000-0000-0000']);

        $response->assertOk()->assertJson(['valid' => false, 'reason' => 'not_found']);
    }

    public function test_expired_license_is_reported_and_marked_expired(): void
    {
        $license = License::factory()->create([
            'status' => 'active',
            'expires_at' => now()->subDay(),
        ]);

        $response = $this->postJson('/api/license/verify', ['license_key' => $license->key]);

        $response->assertOk()->assertJson(['valid' => false, 'reason' => 'expired']);
        $this->assertSame('expired', $license->fresh()->status);
    }

    public function test_revoked_license_is_reported(): void
    {
        $license = License::factory()->create(['status' => 'revoked']);

        $response = $this->postJson('/api/license/verify', ['license_key' => $license->key]);

        $response->assertOk()->assertJson(['valid' => false, 'reason' => 'revoked']);
    }

    public function test_a_known_device_is_always_allowed(): void
    {
        // Codex review (PR #130): device_id was accepted but never enforced —
        // a single one-seat key returned valid:true for arbitrarily many
        // devices. Re-verifying from an ALREADY-recorded device must keep
        // working regardless of how many times it's called.
        $license = License::factory()->create(['status' => 'active', 'seats' => 1]);

        $this->postJson('/api/license/verify', ['license_key' => $license->key, 'device_id' => 'device-a'])
            ->assertOk()->assertJson(['valid' => true]);
        $this->postJson('/api/license/verify', ['license_key' => $license->key, 'device_id' => 'device-a'])
            ->assertOk()->assertJson(['valid' => true]);

        $this->assertSame(1, $license->activations()->count());
    }

    public function test_a_new_device_beyond_seats_is_rejected(): void
    {
        $license = License::factory()->create(['status' => 'active', 'seats' => 1]);

        $this->postJson('/api/license/verify', ['license_key' => $license->key, 'device_id' => 'device-a'])
            ->assertOk()->assertJson(['valid' => true]);

        $response = $this->postJson('/api/license/verify', [
            'license_key' => $license->key, 'device_id' => 'device-b',
        ]);

        $response->assertOk()->assertJson(['valid' => false, 'reason' => 'seat_limit_exceeded']);
        $this->assertSame(1, $license->activations()->count());
    }

    public function test_multiple_devices_allowed_up_to_the_seat_count(): void
    {
        $license = License::factory()->create(['status' => 'active', 'seats' => 3]);

        foreach (['device-a', 'device-b', 'device-c'] as $deviceId) {
            $this->postJson('/api/license/verify', ['license_key' => $license->key, 'device_id' => $deviceId])
                ->assertOk()->assertJson(['valid' => true]);
        }

        $this->assertSame(3, $license->activations()->count());
    }

    public function test_no_device_id_skips_seat_enforcement(): void
    {
        // device_id is nullable — there's no identity to track without it.
        $license = License::factory()->create(['status' => 'active', 'seats' => 1]);
        $license->activations()->create([
            'device_id' => 'device-a', 'first_seen_at' => now(), 'last_seen_at' => now(),
        ]);

        $response = $this->postJson('/api/license/verify', ['license_key' => $license->key]);

        $response->assertOk()->assertJson(['valid' => true]);
        $this->assertSame(1, $license->activations()->count());
    }
}
