<?php

namespace App\Models;

use Database\Factories\LicenseFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'user_id', 'key', 'tier', 'status', 'seats',
    'stripe_subscription_id', 'issued_at', 'expires_at', 'last_verified_at', 'notes',
    'last_stripe_event_at',
])]
class License extends Model
{
    /** @use HasFactory<LicenseFactory> */
    use HasFactory;

    protected function casts(): array
    {
        return [
            'seats' => 'integer',
            'issued_at' => 'datetime',
            'expires_at' => 'datetime',
            'last_verified_at' => 'datetime',
            'last_stripe_event_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return HasMany<LicenseActivation, $this> */
    public function activations(): HasMany
    {
        return $this->hasMany(LicenseActivation::class);
    }

    /**
     * Why this license currently fails validation, or null if it's valid.
     * The single source of truth both isCurrentlyValid() and
     * Api\LicenseVerifyController's JSON "reason" field derive from, so the
     * two can never silently disagree about the same license.
     */
    public function invalidReason(): ?string
    {
        if ($this->status !== 'active') {
            return $this->status;
        }

        if ($this->expires_at !== null && $this->expires_at->isPast()) {
            return 'expired';
        }

        return null;
    }

    public function isCurrentlyValid(): bool
    {
        return $this->invalidReason() === null;
    }
}
