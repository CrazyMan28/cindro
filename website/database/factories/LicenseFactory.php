<?php

namespace Database\Factories;

use App\Models\License;
use App\Models\User;
use App\Services\LicenseKeyGenerator;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<License>
 */
class LicenseFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'key' => LicenseKeyGenerator::generate(),
            'tier' => $this->faker->randomElement(['trial', 'starter', 'pro', 'business', 'enterprise']),
            'status' => 'active',
            'seats' => 1,
            'issued_at' => now(),
            'expires_at' => null,
        ];
    }
}
