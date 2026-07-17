<?php

use App\Http\Controllers\CheckoutController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\DownloadController;
use App\Http\Controllers\MarketingController;
use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;

Route::get('/', [MarketingController::class, 'landing'])->name('landing');
Route::get('/pricing', [MarketingController::class, 'pricing'])->name('pricing');
Route::get('/download', [DownloadController::class, 'index'])->name('download');
Route::get('/terms', [MarketingController::class, 'terms'])->name('terms');
Route::get('/privacy', [MarketingController::class, 'privacy'])->name('privacy');

Route::get('/dashboard', [DashboardController::class, 'index'])
    ->middleware(['auth', 'verified'])
    ->name('dashboard');

Route::middleware('auth')->group(function () {
    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');

    Route::get('/checkout/{tier}', [CheckoutController::class, 'subscribe'])->name('checkout.subscribe');
    Route::get('/billing-portal', [DashboardController::class, 'billingPortal'])->name('billing-portal');
});

require __DIR__.'/auth.php';
