<?php

use App\Http\Controllers\Admin\VaccineController;
use App\Http\Controllers\BookingController;
use App\Http\Controllers\PaymentController;
use App\Http\Controllers\TicketController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
})->name('home');

Route::view('/about', 'about')->name('about');

Route::middleware('auth')->group(function () {
    Route::prefix('booking')->name('booking.')->controller(BookingController::class)->group(function () {
        Route::get('/', 'index')->name('index');
        Route::get('/create', 'create')->name('create');
        Route::post('/', 'store')->name('store');
        Route::get('/{booking}', 'show')->name('show');
        Route::delete('/{booking}', 'cancel')->name('cancel');
    });

    Route::get('/booking/{booking}/pay', [PaymentController::class, 'show'])->name('payment.show');
    Route::post('/booking/{booking}/pay', [PaymentController::class, 'pay'])->name('payment.pay');
    Route::get('/payment/failed', [PaymentController::class, 'failed'])->name('payment.failed');

    Route::get('/tickets/{ticket}', [TicketController::class, 'show'])->name('tickets.show');
});

Route::prefix('admin')->name('admin.')->middleware(['auth', 'can:admin'])->group(function () {
    Route::resource('vaccines', VaccineController::class)->except(['show']);
});

Route::redirect('/home', '/');

require __DIR__.'/auth.php';
