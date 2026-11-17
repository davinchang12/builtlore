<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('purchase_requests', function (Blueprint $table) {
            $table->id();
            $table->string('title', 150);
            $table->foreignId('item_id')->constrained('items');
            $table->unsignedInteger('qty');
            $table->decimal('amount', 15, 2)->default(0);
            $table->string('pic_nik', 20)->nullable();
            $table->string('manager_nik', 20)->index();
            $table->string('status', 30)->default('WAITING_MANAGER')->index();
            $table->text('hold_reason')->nullable();
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('leave_requests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->date('from');
            $table->date('to');
            $table->text('reason')->nullable();
            $table->enum('status', ['pending', 'approved', 'rejected'])->default('pending');
            $table->string('attachment')->nullable();
            $table->timestamps();
        });
    }
};
