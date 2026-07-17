<?php

use App\Http\Controllers\Api\LicenseVerifyController;
use Illuminate\Support\Facades\Route;

Route::post('/license/verify', LicenseVerifyController::class)
    ->middleware('throttle:30,1')
    ->name('api.license.verify');
