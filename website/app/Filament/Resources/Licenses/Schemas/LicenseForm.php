<?php

namespace App\Filament\Resources\Licenses\Schemas;

use App\Services\LicenseKeyGenerator;
use App\Support\PricingCatalog;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Textarea;
use Filament\Schemas\Schema;

class LicenseForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                Select::make('user_id')
                    ->relationship('user', 'email')
                    ->searchable()
                    ->helperText('Leave blank for a pre-issued license not yet claimed by an account.'),
                TextInput::make('key')
                    ->required()
                    ->default(fn () => LicenseKeyGenerator::generate())
                    ->disabled(fn (string $operation) => $operation === 'edit')
                    ->dehydrated()
                    ->unique(ignoreRecord: true),
                Select::make('tier')
                    ->options(PricingCatalog::tierSelectOptions())
                    ->required(),
                Select::make('status')
                    ->options(PricingCatalog::licenseStatusSelectOptions())
                    ->default('active')
                    ->required(),
                TextInput::make('seats')
                    ->required()
                    ->numeric()
                    ->default(1),
                TextInput::make('stripe_subscription_id')
                    ->label('Stripe subscription ID')
                    ->helperText('Left blank for manually-issued licenses (not tied to Stripe billing).')
                    ->disabled(),
                DateTimePicker::make('issued_at')
                    ->default(now()),
                DateTimePicker::make('expires_at')
                    ->helperText('Leave blank for licenses tied to a live subscription.'),
                DateTimePicker::make('last_verified_at')
                    ->disabled(),
                Textarea::make('notes')
                    ->columnSpanFull(),
            ]);
    }
}
