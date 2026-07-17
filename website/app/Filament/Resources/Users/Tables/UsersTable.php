<?php

namespace App\Filament\Resources\Users\Tables;

use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\TernaryFilter;
use Filament\Tables\Table;

class UsersTable
{
    public static function configure(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')
                    ->searchable(),
                TextColumn::make('email')
                    ->label('Email address')
                    ->searchable(),
                TextColumn::make('subscription_status')
                    ->label('Subscription')
                    ->state(function ($record) {
                        if ($record->subscribed('default')) {
                            return 'subscribed';
                        }

                        if ($record->onGenericTrial()) {
                            return 'trialing';
                        }

                        return 'none';
                    })
                    ->badge()
                    ->color(fn (string $state) => match ($state) {
                        'subscribed' => 'success',
                        'trialing' => 'warning',
                        default => 'gray',
                    }),
                TextColumn::make('trial_ends_at')
                    ->dateTime()
                    ->sortable(),
                IconColumn::make('is_founding_member')
                    ->boolean(),
                IconColumn::make('is_admin')
                    ->label('Admin')
                    ->boolean(),
                TextColumn::make('created_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                TernaryFilter::make('is_founding_member'),
                TernaryFilter::make('is_admin'),
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
