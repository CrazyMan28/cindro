<?php

namespace App\Http\Controllers;

use App\Http\Requests\ProfileUpdateRequest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Redirect;
use Illuminate\View\View;

class ProfileController extends Controller
{
    /**
     * Display the user's profile form.
     */
    public function edit(Request $request): View
    {
        return view('profile.edit', [
            'user' => $request->user(),
        ]);
    }

    /**
     * Update the user's profile information.
     */
    public function update(ProfileUpdateRequest $request): RedirectResponse
    {
        $request->user()->fill($request->validated());

        if ($request->user()->isDirty('email')) {
            $request->user()->email_verified_at = null;
        }

        $request->user()->save();

        return Redirect::route('profile.edit')->with('status', 'profile-updated');
    }

    /**
     * Delete the user's account.
     */
    public function destroy(Request $request): RedirectResponse
    {
        $request->validateWithBag('userDeletion', [
            'password' => ['required', 'current_password'],
        ]);

        $user = $request->user();

        Auth::logout();

        // Codex review (PR #130): licenses.user_id uses nullOnDelete, so
        // deleting the user without this left every license (a paid one has
        // no fixed expiry) still "active" forever with an orphaned
        // user_id=null row — /api/license/verify kept validating it, and a
        // later Stripe webhook couldn't fix it either (SyncLicenseFromStripeWebhook
        // looks the user up by stripe_id, which is now gone). Cancel any live
        // Cashier subscriptions and revoke every license BEFORE the user row
        // disappears.
        foreach ($user->subscriptions as $subscription) {
            if (! $subscription->ended()) {
                $subscription->cancelNow();
            }
        }
        $user->licenses()->update(['status' => 'revoked']);

        $user->delete();

        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return Redirect::to('/');
    }
}
