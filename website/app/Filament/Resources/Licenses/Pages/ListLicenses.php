<?php

namespace App\Filament\Resources\Licenses\Pages;

use App\Filament\Resources\Licenses\LicenseResource;
use App\Models\License;
use App\Services\LicenseKeyGenerator;
use App\Support\PricingCatalog;
use Filament\Actions\Action;
use Filament\Actions\CreateAction;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\ListRecords;
use Illuminate\Database\QueryException;

class ListLicenses extends ListRecords
{
    protected static string $resource = LicenseResource::class;

    protected function getHeaderActions(): array
    {
        return [
            Action::make('issueManualLicense')
                ->label('Issue Manual License')
                ->icon('heroicon-o-key')
                ->schema([
                    Select::make('user_id')
                        ->label('User')
                        ->relationship('user', 'email')
                        ->searchable()
                        ->required(),
                    Select::make('tier')
                        // Trial is deliberately excluded — it's tied to the registration
                        // flow, not something an admin manually grants.
                        ->options(collect(PricingCatalog::tierSelectOptions())->except('trial'))
                        ->required(),
                    TextInput::make('seats')->numeric()->default(1)->required(),
                    DateTimePicker::make('expires_at')
                        ->helperText('Leave blank for a license with no fixed end date.'),
                ])
                ->action(function (array $data): void {
                    retry(3, fn () => License::create([
                        'user_id' => $data['user_id'],
                        'key' => LicenseKeyGenerator::generate(),
                        'tier' => $data['tier'],
                        'status' => 'active',
                        'seats' => $data['seats'],
                        'stripe_subscription_id' => null,
                        'issued_at' => now(),
                        'expires_at' => $data['expires_at'] ?? null,
                        'notes' => 'Manually issued via admin panel.',
                    ]), 0, fn (\Throwable $e) => $e instanceof QueryException);

                    Notification::make()
                        ->title('License issued')
                        ->success()
                        ->send();
                }),
            CreateAction::make(),
        ];
    }
}
