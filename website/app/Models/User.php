<?php

namespace App\Models;

use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;
use Laravel\Cashier\Billable;

#[Fillable([
    'name', 'email', 'password', 'trial_ends_at',
    'is_founding_member', 'founding_member_number', 'is_admin',
])]
#[Hidden(['password', 'remember_token'])]
// Codex review (PR #130): this was commented out — the `verified` middleware
// (routes/web.php's /dashboard route) and Breeze's verify-email routes
// (routes/auth.php) were already fully wired, but with no MustVerifyEmail
// implementation the middleware treats every authenticated user as verified
// and Registered's SendEmailVerificationNotification listener never fires,
// so an arbitrary unverified address could reach the dashboard and obtain a
// trial license.
class User extends Authenticatable implements FilamentUser, MustVerifyEmail
{
    /** @use HasFactory<UserFactory> */
    use Billable, HasFactory, Notifiable;

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_founding_member' => 'boolean',
            'is_admin' => 'boolean',
            // Cashier's Billable trait relies on the consuming model to cast this —
            // it's not automatic. Without it, onGenericTrial()/onTrial() crash
            // calling ->isFuture() on a plain DB string for any freshly-hydrated user.
            'trial_ends_at' => 'datetime',
        ];
    }

    /**
     * Gate to the Filament admin panel — customers register through Breeze like
     * anyone else, so panel access must be restricted to staff explicitly, not
     * granted to every authenticated user.
     */
    public function canAccessPanel(Panel $panel): bool
    {
        return $this->is_admin;
    }

    /** @return HasMany<License, $this> */
    public function licenses(): HasMany
    {
        return $this->hasMany(License::class);
    }

    /** @return HasMany<PhoneNumber, $this> */
    public function phoneNumbers(): HasMany
    {
        return $this->hasMany(PhoneNumber::class);
    }

    /**
     * Single source of truth for how many founding-member slots are claimed —
     * shared by the checkout coupon gate and the marketing landing-page banner
     * so they can never read a different count from each other.
     */
    public static function foundingMembersClaimedCount(): int
    {
        return static::where('is_founding_member', true)->count();
    }

    /**
     * Grants founding-member status if a slot is still available, assigning the
     * next sequential number. Called once a subscription is actually confirmed
     * (by the Stripe webhook listener) rather than at checkout-initiation time,
     * so only customers who actually completed a subscription count against the
     * cap. Wrapped in a transaction to shrink (not eliminate) the race window
     * between concurrent confirmations — the cap is a marketing commitment, not
     * a hard financial guarantee, so this doesn't need distributed locking.
     */
    public function grantFoundingMemberStatusIfSlotAvailable(): void
    {
        if ($this->is_founding_member) {
            return;
        }

        DB::transaction(function () {
            $claimed = static::foundingMembersClaimedCount();

            if ($claimed >= config('cindro.founding_member_cap')) {
                return;
            }

            $this->update([
                'is_founding_member' => true,
                'founding_member_number' => $claimed + 1,
            ]);
        });
    }
}
