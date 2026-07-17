<?php

namespace Database\Seeders;

use App\Models\License;
use App\Models\User;
use App\Services\LicenseKeyGenerator;
use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    use WithoutModelEvents;

    /**
     * Seed the application's database for local development: a Filament admin
     * login and one sample user per tier so /admin and /dashboard have
     * something real to look at.
     */
    public function run(): void
    {
        $admin = User::factory()->create([
            'name' => 'Admin',
            'email' => 'admin@cindro.test',
            'is_admin' => true,
        ]);

        $admin->licenses()->create([
            'key' => LicenseKeyGenerator::generate(),
            'tier' => 'enterprise',
            'status' => 'active',
            'issued_at' => now(),
        ]);

        foreach (['trial', 'starter', 'pro', 'business'] as $tier) {
            $user = User::factory()->create([
                'name' => ucfirst($tier).' User',
                'email' => "{$tier}@cindro.test",
                'trial_ends_at' => $tier === 'trial' ? now()->addDays(config('cindro.trial_days')) : null,
            ]);

            $user->licenses()->create([
                'key' => LicenseKeyGenerator::generate(),
                'tier' => $tier,
                'status' => 'active',
                'issued_at' => now(),
                'expires_at' => $tier === 'trial' ? $user->trial_ends_at : null,
            ]);
        }

        // An expired/revoked license so /api/license/verify's failure paths have real data to hit.
        License::factory()->create([
            'key' => LicenseKeyGenerator::generate(),
            'tier' => 'starter',
            'status' => 'expired',
            'issued_at' => now()->subYear(),
            'expires_at' => now()->subMonth(),
        ]);
    }
}
