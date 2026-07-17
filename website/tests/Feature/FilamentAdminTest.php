<?php

namespace Tests\Feature;

use App\Models\License;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FilamentAdminTest extends TestCase
{
    use RefreshDatabase;

    public function test_guests_are_redirected_to_admin_login(): void
    {
        $this->get('/admin/users')->assertRedirect('/admin/login');
    }

    public function test_regular_customers_cannot_access_the_admin_panel(): void
    {
        $customer = User::factory()->create(['email_verified_at' => now(), 'is_admin' => false]);

        $this->actingAs($customer)->get('/admin/users')->assertForbidden();
    }

    public function test_admin_flagged_user_can_view_users_and_licenses_resources(): void
    {
        $admin = User::factory()->create(['email_verified_at' => now(), 'is_admin' => true]);
        License::factory()->create(['tier' => 'pro']);

        $this->actingAs($admin)
            ->get('/admin/users')
            ->assertOk()
            ->assertSee($admin->email);

        $this->actingAs($admin)
            ->get('/admin/licenses')
            ->assertOk();
    }
}
