<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class MarketingPagesTest extends TestCase
{
    use RefreshDatabase;

    public function test_landing_page_renders(): void
    {
        $this->get('/')->assertOk()->assertSee('Cindro');
    }

    public function test_pricing_page_renders_all_tiers(): void
    {
        $response = $this->get('/pricing');

        $response->assertOk();

        foreach (['Free Trial', 'Starter', 'Pro', 'Business', 'Enterprise'] as $tierLabel) {
            $response->assertSee($tierLabel);
        }
    }

    public function test_terms_and_privacy_pages_render_with_draft_banner(): void
    {
        $this->get('/terms')->assertOk()->assertSee('pending legal review');
        $this->get('/privacy')->assertOk()->assertSee('pending legal review');
    }
}
