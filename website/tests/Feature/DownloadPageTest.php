<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DownloadPageTest extends TestCase
{
    use RefreshDatabase;

    public function test_download_page_falls_back_gracefully_without_a_github_token(): void
    {
        config(['services.github.token' => null]);

        $this->get('/download')
            ->assertOk()
            ->assertSee('Download links unavailable');
    }
}
