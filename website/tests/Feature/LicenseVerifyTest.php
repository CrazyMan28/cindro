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
}
