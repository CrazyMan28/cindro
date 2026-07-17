<?php

namespace Tests\Unit;

use App\Support\PricingCatalog;
use Tests\TestCase;

class PricingCatalogTest extends TestCase
{
    public function test_not_included_strings_flag_as_false(): void
    {
        // Codex review (PR #130): every string-valued cell used to flag true
        // unconditionally, including explicit exclusions like Starter's
        // cloned_voice "not included" — contradicting the pricing table
        // /api/license/verify's "features" map is meant to mirror.
        $flags = PricingCatalog::booleanFeatureFlags('starter');

        $this->assertFalse($flags['cloned_voice']);
        $this->assertFalse($flags['hosted_pairing_relay']);
    }

    public function test_a_string_describing_an_available_feature_flags_as_true(): void
    {
        // Trial's cloned_voice is "preview (5 generations)" — available, just
        // limited — and hosted_phone_number is available with tier-specific
        // caveats on every tier, never a "not included" string.
        $flags = PricingCatalog::booleanFeatureFlags('trial');

        $this->assertTrue($flags['cloned_voice']);
        $this->assertTrue($flags['hosted_phone_number']);
    }

    public function test_plain_boolean_cells_are_unaffected(): void
    {
        $flags = PricingCatalog::booleanFeatureFlags('business');

        $this->assertTrue($flags['proxmox_agent']);
        $this->assertTrue($flags['shared_team_memory']);
    }
}
