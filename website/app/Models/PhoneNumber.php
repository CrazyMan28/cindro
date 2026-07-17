<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable([
    'user_id', 'e164_number', 'provider', 'status',
    'minutes_used', 'sms_used', 'minutes_cap', 'sms_cap', 'released_at',
])]
class PhoneNumber extends Model
{
    protected function casts(): array
    {
        return [
            'minutes_used' => 'integer',
            'sms_used' => 'integer',
            'minutes_cap' => 'integer',
            'sms_cap' => 'integer',
            'released_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
