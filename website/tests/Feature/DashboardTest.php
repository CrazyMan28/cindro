<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DashboardTest extends TestCase
{
    use RefreshDatabase;

    public function test_guests_are_redirected_to_login(): void
    {
        $this->get('/dashboard')->assertRedirect('/login');
    }

    public function test_trialing_user_sees_trial_status(): void
    {
        $user = User::factory()->create([
            'email_verified_at' => now(),
            'trial_ends_at' => now()->addDays(14),
        ]);

        $this->actingAs($user)
            ->get('/dashboard')
            ->assertOk()
            ->assertSee('Free trial');
    }

    public function test_prefers_a_valid_license_over_a_newer_invalid_one(): void
    {
        // Codex review (PR #130): picking solely by issued_at could select a
        // newer-but-invalid license (expired/suspended/revoked) over an older
        // one that's still valid, wrongly denying downloads.
        $user = User::factory()->create(['email_verified_at' => now()]);
        $user->licenses()->create([
            'key' => 'CIND-OLD-VALID-0001',
            'tier' => 'pro',
            'status' => 'active',
            'issued_at' => now()->subDays(30),
        ]);
        $user->licenses()->create([
            'key' => 'CIND-NEW-EXPIRED-0001',
            'tier' => 'pro',
            'status' => 'expired',
            'issued_at' => now(),
        ]);

        $this->actingAs($user)
            ->get('/dashboard')
            ->assertOk()
            ->assertSee('CIND-OLD-VALID-0001');
    }
}
