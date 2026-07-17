<?php

namespace App\Filament\Resources\Users\Schemas;

use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Schemas\Schema;

class UserForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextInput::make('name')
                    ->required(),
                TextInput::make('email')
                    ->label('Email address')
                    ->email()
                    ->required(),
                DateTimePicker::make('email_verified_at'),
                TextInput::make('password')
                    ->password()
                    ->dehydrateStateUsing(fn ($state) => \Illuminate\Support\Facades\Hash::make($state))
                    ->dehydrated(fn ($state) => filled($state))
                    ->required(fn (string $operation) => $operation === 'create'),
                TextInput::make('stripe_id')
                    ->label('Stripe customer ID')
                    ->disabled(),
                DateTimePicker::make('trial_ends_at'),
                Toggle::make('is_founding_member')
                    ->required(),
                TextInput::make('founding_member_number')
                    ->numeric(),
                Toggle::make('is_admin')
                    ->label('Admin (Filament panel access)')
                    ->helperText('Grants access to this admin panel — not a customer-facing flag.')
                    ->required(),
            ]);
    }
}
