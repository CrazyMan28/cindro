<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RegistrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_registration_screen_can_be_rendered(): void
    {
        $response = $this->get('/register');

        $response->assertStatus(200);
    }

    public function test_new_users_can_register(): void
    {
        $response = $this->post('/register', [
            'name' => 'Test User',
            'email' => 'test@example.com',
            'password' => 'password',
            'password_confirmation' => 'password',
        ]);

        $this->assertAuthenticated();
        $response->assertRedirect(route('dashboard', absolute: false));
    }

    public function test_registration_starts_a_real_trial_via_mass_assignment(): void
    {
        // Regression test: User's #[Fillable] attribute must include trial_ends_at,
        // and it must be cast to datetime, or this silently no-ops and every new
        // registrant gets no trial (or, worse, a trial license that never expires).
        $this->post('/register', [
            'name' => 'Test User',
            'email' => 'trial-check@example.com',
            'password' => 'password',
            'password_confirmation' => 'password',
        ]);

        $user = User::where('email', 'trial-check@example.com')->firstOrFail();

        $this->assertNotNull($user->trial_ends_at);
        $this->assertTrue($user->onGenericTrial());

        $license = $user->licenses()->firstOrFail();
        $this->assertNotNull($license->expires_at);
        $this->assertTrue($license->expires_at->isFuture());
    }
}
