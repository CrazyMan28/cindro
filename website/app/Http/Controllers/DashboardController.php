<?php

namespace App\Http\Controllers;

use App\Services\GitHubReleaseService;
use Illuminate\Http\Request;

class DashboardController extends Controller
{
    public function index(Request $request, GitHubReleaseService $releases)
    {
        $user = $request->user();

        $primaryLicense = $user->licenses()->latest('issued_at')->first();
        $canDownload = $primaryLicense && $primaryLicense->isCurrentlyValid();

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
