<?php

namespace Tests\Unit;

use App\Services\GitHubReleaseService;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class GitHubReleaseServiceTest extends TestCase
{
    public function test_maps_release_assets_to_platforms(): void
    {
        config(['services.github.token' => 'fake-token', 'services.github.repo' => 'CrazyMan28/jarvis']);

        Http::fake([
            'api.github.com/*' => Http::response([
                'tag_name' => 'v0.13.0',
                'assets' => [
                    ['name' => 'Cindro-Setup-0.13.0.exe', 'browser_download_url' => 'https://example.test/win.exe'],
                    ['name' => 'Cindro-0.13.0.AppImage', 'browser_download_url' => 'https://example.test/linux.AppImage'],
                    ['name' => 'Cindro-0.13.0.apk', 'browser_download_url' => 'https://example.test/android.apk'],
                    ['name' => 'Cindro-0.13.0.ipa', 'browser_download_url' => 'https://example.test/ios.ipa'],
                ],
            ], 200),
        ]);

        $release = (new GitHubReleaseService)->latestRelease();

        $this->assertSame('v0.13.0', $release['version']);
        $this->assertSame([
            'windows' => 'https://example.test/win.exe',
            'linux' => 'https://example.test/linux.AppImage',
            'android' => 'https://example.test/android.apk',
            'ios' => 'https://example.test/ios.ipa',
        ], $release['platforms']);
    }

    public function test_returns_null_without_a_token(): void
    {
        config(['services.github.token' => null]);

        $this->assertNull((new GitHubReleaseService)->latestRelease());
    }

    public function test_returns_null_on_api_failure(): void
    {
        config(['services.github.token' => 'fake-token']);

        Http::fake(['api.github.com/*' => Http::response(null, 500)]);

        $this->assertNull((new GitHubReleaseService)->latestRelease());
    }
}
