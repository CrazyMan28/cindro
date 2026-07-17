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
        Schema::create('phone_numbers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('e164_number')->nullable();
            $table->enum('provider', ['hosted', 'byo_twilio'])->default('hosted');
            $table->enum('status', ['pending', 'active', 'released'])->default('pending');
            $table->unsignedInteger('minutes_used')->default(0);
            $table->unsignedInteger('sms_used')->default(0);
            $table->unsignedInteger('minutes_cap')->nullable();
            $table->unsignedInteger('sms_cap')->nullable();
            $table->timestamp('released_at')->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('phone_numbers');
    }
};
