<?php

use App\Http\Controllers\Api\PaymentWebhookController;
use App\Http\Controllers\Api\SlotController;
use Illuminate\Support\Facades\Route;

Route::get('/slots', [SlotController::class, 'index'])->name('api.slots');
Route::post('/payments/webhook', PaymentWebhookController::class)->name('api.payments.webhook');
