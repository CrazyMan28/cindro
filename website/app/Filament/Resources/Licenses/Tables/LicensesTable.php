<?php

namespace App\Filament\Resources\Licenses\Tables;

use App\Support\PricingCatalog;
use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class LicensesTable
{
    public static function configure(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('key')
                    ->searchable()
                    ->copyable(),
                TextColumn::make('user.email')
                    ->label('User')
                    ->searchable()
                    ->placeholder('unclaimed'),
                TextColumn::make('tier')
                    ->badge()
                    ->searchable(),
                TextColumn::make('status')
                    ->badge()
                    ->color(fn (string $state) => match ($state) {
                        'active' => 'success',
                        'suspended' => 'warning',
                        default => 'danger',
                    }),
                TextColumn::make('seats')
                    ->numeric()
                    ->sortable(),
                TextColumn::make('stripe_subscription_id')
                    ->label('Stripe subscription')
                    ->placeholder('manual')
                    ->toggleable(isToggledHiddenByDefault: true),
                TextColumn::make('expires_at')
                    ->dateTime()
                    ->sortable()
                    ->placeholder('no fixed end'),
                TextColumn::make('last_verified_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
                TextColumn::make('created_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                SelectFilter::make('tier')->options(PricingCatalog::tierSelectOptions()),
                SelectFilter::make('status')->options(PricingCatalog::licenseStatusSelectOptions()),
            ])
            ->recordActions([
                EditAction::make(),
            ])
            ->toolbarActions([
                BulkActionGroup::make([
                    DeleteBulkAction::make(),
                ]),
            ]);
    }
}
