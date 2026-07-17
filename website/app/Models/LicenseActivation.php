<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One (license, device) pair /api/license/verify has actually seen — see
 * LicenseVerifyController and the license_activations migration. Enforces
 * License::seats: a NEW device beyond that count is rejected rather than
 * silently granted access, so a one-seat key can't be shared unlimited.
 */
#[Fillable(['license_id', 'device_id', 'first_seen_at', 'last_seen_at'])]
class LicenseActivation extends Model
{
    protected function casts(): array
    {
        return [
            'first_seen_at' => 'datetime',
            'last_seen_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<License, $this> */
    public function license(): BelongsTo
    {
        return $this->belongsTo(License::class);
    }
}
