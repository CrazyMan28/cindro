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
        Schema::table('licenses', function (Blueprint $table) {
            // Stripe's own `created` timestamp (event.created, unix seconds)
            // for the last webhook actually applied to this license — webhook
            // delivery is not guaranteed to preserve order, so a delayed
            // pre-cancellation `updated` event arriving after a `deleted`
            // event must not reactivate an already-expired license.
            // SyncLicenseFromStripeWebhook stamps this on every applied event
            // and refuses to apply one older than what's already here.
            $table->timestamp('last_stripe_event_at')->nullable()->after('expires_at');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('licenses', function (Blueprint $table) {
            $table->dropColumn('last_stripe_event_at');
        });
    }
};
