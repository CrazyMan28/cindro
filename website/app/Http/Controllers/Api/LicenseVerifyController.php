<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\License;
use App\Support\PricingCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The one real integration point back into the main Cindro product (per sell.md).
 * A future core/ LicenseStore (mirroring the existing SettingsStore pattern) is
 * meant to call this endpoint to gate Pro-only features, with a graceful offline
 * fallback. No core/ changes are made in this task — this is just the contract.
 *
 * Request:  POST /api/license/verify {"license_key": "CIND-...", "device_id"?: "..."}
 *
 * Response — valid  (200): {valid: true, tier, status, expires_at, seats, features, checked_at}
 * Response — invalid (200, still — a clean "no/expired/revoked" answer is a normal
 *   cacheable result, not a transport error): {valid: false, reason: "not_found"|"expired"|"revoked"|"suspended"}
 *
 * Only genuine network/5xx failures should read as "verification unavailable" on
 * the daemon side — that distinction is what lets a future offline fallback tell
 * "definitely invalid" apart from "couldn't check."
 */
class LicenseVerifyController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $request->validate([
            'license_key' => ['required', 'string'],
            'device_id' => ['nullable', 'string'],
        ]);

        $license = License::where('key', $request->string('license_key'))->first();

        if (! $license) {
            return response()->json(['valid' => false, 'reason' => 'not_found']);
        }

        $reason = $license->invalidReason();

        if ($reason === 'expired' && $license->status !== 'expired') {
            // Lazily persist the active -> expired transition discovered by date.
            $license->status = 'expired';
        }

        $license->forceFill(['last_verified_at' => now()])->save();

        if ($reason !== null) {
            return response()->json(['valid' => false, 'reason' => $reason]);
        }

        return response()->json([
            'valid' => true,
            'tier' => $license->tier,
            'status' => $license->status,
            'expires_at' => $license->expires_at?->toIso8601String(),
            'seats' => $license->seats,
            'features' => PricingCatalog::booleanFeatureFlags($license->tier),
            'checked_at' => now()->toIso8601String(),
        ]);
    }
}
