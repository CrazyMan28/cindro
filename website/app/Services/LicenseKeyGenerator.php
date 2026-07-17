<?php

namespace App\Services;

use App\Models\License;
use Illuminate\Support\Str;

class LicenseKeyGenerator
{
    /**
     * Generate a unique CIND-XXXX-XXXX-XXXX license key.
     */
    public static function generate(): string
    {
        do {
            $key = 'CIND-'.collect(range(1, 3))
                ->map(fn () => Str::upper(Str::random(4)))
                ->implode('-');
        } while (License::where('key', $key)->exists());

        return $key;
    }
}
