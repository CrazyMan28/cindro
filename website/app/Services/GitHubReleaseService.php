<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Fetches the latest GitHub Release for the product repo, mapping its assets to
 * download cards per platform. The repo (CrazyMan28/jarvis) is private, so a
 * GITHUB_TOKEN is required for a real API call — without one (or on any
 * API/network failure) this returns null and the /download view falls back to a
 * static "see GitHub Releases directly" link. It never throws into the view.
 *
 * Known limitation: even once fetched, a private repo's release ASSET urls are
 * not anonymously downloadable — a logged-out visitor hits GitHub's auth wall
 * until the repo goes public. See the TODO below for the alternative (a
 * server-side download-proxy route), which is a real launch decision, not
 * something this scaffold resolves.
 */
class GitHubReleaseService
{
    private const CACHE_KEY = 'github:latest_release';

    private const CACHE_MINUTES = 15;

    /** @return array{version: string, platforms: array<string, string>}|null */
    public function latestRelease(): ?array
    {
        // Cache::remember can't distinguish "not cached" from "cached as null" —
        // it treats both as a miss and re-invokes the callback every time. Wrap
        // the nullable result in an always-non-null envelope so a failed/empty
        // fetch (missing token, GitHub down, rate-limited) is genuinely cached
        // for the full TTL instead of hitting the live API on every request.
        $envelope = Cache::remember(self::CACHE_KEY, now()->addMinutes(self::CACHE_MINUTES), function () {
            return ['release' => $this->fetchLatestRelease()];
        });

        return $envelope['release'];
    }

    /** @return array{version: string, platforms: array<string, string>}|null */
    private function fetchLatestRelease(): ?array
    {
        $token = config('services.github.token');
        $repo = config('services.github.repo');

        if (! $token || ! $repo) {
            return null;
        }

        try {
            $response = Http::withToken($token)
                ->acceptJson()
                ->timeout(5)
                ->get("https://api.github.com/repos/{$repo}/releases/latest");
        } catch (Throwable) {
            return null;
        }

        if (! $response->successful()) {
            return null;
        }

        $data = $response->json();
        $assets = $data['assets'] ?? [];

        return [
            'version' => $data['tag_name'] ?? 'unknown',
            'platforms' => $this->mapAssetsToPlatforms($assets),
        ];
    }

    /**
     * @param  list<array{name: string, browser_download_url: string}>  $assets
     * @return array<string, string>
     */
    private function mapAssetsToPlatforms(array $assets): array
    {
        $platforms = [];

        foreach ($assets as $asset) {
            $name = $asset['name'] ?? '';
            $url = $asset['browser_download_url'] ?? null;

            if (! $url) {
                continue;
            }

            // TODO: repo is private — these direct asset URLs hit GitHub's auth
            // wall for a logged-out visitor until the repo goes public. The
            // alternative is a /download/proxy/{platform} route that streams
            // the bytes server-side using this same token — a real launch
            // decision, not solved here.
            match (true) {
                (bool) preg_match('/\.exe$/i', $name) => $platforms['windows'] = $url,
                (bool) preg_match('/\.AppImage$/i', $name) => $platforms['linux'] = $url,
                (bool) preg_match('/\.apk$/i', $name) => $platforms['android'] = $url,
                (bool) preg_match('/\.ipa$/i', $name) => $platforms['ios'] = $url,
                default => null,
            };
        }

        return $platforms;
    }
}
