<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        // Codex review (PR #130): /api/license/verify accepted `device_id` but
        // never recorded or enforced it, so a single one-seat key could
        // return valid:true for arbitrarily many devices — per-seat Business
        // licensing was unenforceable. One row per (license, device) the
        // license has actually been verified from; a NEW device beyond
        // `licenses.seats` is rejected instead of silently accepted (see
        // LicenseVerifyController).
        Schema::create('license_activations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('license_id')->constrained()->cascadeOnDelete();
            $table->string('device_id');
            $table->timestamp('first_seen_at');
            $table->timestamp('last_seen_at');
            $table->timestamps();

            $table->unique(['license_id', 'device_id']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('license_activations');
    }
};
