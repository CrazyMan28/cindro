<?php

namespace App\Http\Controllers;

use App\Services\GitHubReleaseService;
use Illuminate\Http\Request;

class DashboardController extends Controller
{
    public function index(Request $request, GitHubReleaseService $releases)
    {
        $user = $request->user();

        // Codex review (PR #130): a user can hold multiple licenses (the admin
        // resources explicitly allow it — e.g. an old expired subscription
        // alongside a still-valid manually issued one). Picking solely by
        // issued_at could select the newest-but-invalid row, denying
        // downloads and showing an invalid license even though
        // /api/license/verify would still accept a valid one this user holds.
        // Prefer a currently-valid license (newest among valid ones); fall
        // back to the newest overall only when none are valid, so the
        // dashboard still has something to display.
        $licenses = $user->licenses()->latest('issued_at')->get();
        $primaryLicense = $licenses->first(fn ($license) => $license->isCurrentlyValid()) ?? $licenses->first();
        $canDownload = $primaryLicense !== null && $primaryLicense->isCurrentlyValid();

        return view('dashboard', [
            'onTrial' => $user->onGenericTrial(),
            'subscribed' => $user->subscribed('default'),
            'trialEndsAt' => $user->trial_ends_at,
            'primaryLicense' => $primaryLicense,
            'phoneNumbers' => $user->phoneNumbers,
            'canDownload' => $canDownload,
            'release' => $canDownload ? $releases->latestRelease() : null,
        ]);
    }

    public function billingPortal(Request $request)
    {
        return $request->user()->redirectToBillingPortal(route('dashboard'));
    }
}
