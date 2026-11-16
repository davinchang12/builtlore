<?php

use App\Http\Controllers\DashboardController;
use App\Http\Controllers\GetDataController;
use App\Http\Controllers\LeaveRequestController;
use App\Http\Controllers\LoginController;
use App\Http\Controllers\Master\DepartmentController;
use App\Http\Controllers\Master\ItemController;
use App\Http\Controllers\Master\SupplierController;
use App\Http\Controllers\PurchaseRequestController;
use App\Http\Controllers\ReportController;
use App\Http\Controllers\StatusLeaveRequestController;
use App\Http\Controllers\StatusPurchaseRequestController;
use Illuminate\Support\Facades\Route;

Route::get('/', [DashboardController::class, 'index'])->middleware('auth')->name('dashboard');

Route::get('/logon/{nik}', [LoginController::class, 'sso']);
Route::get('/logon/{nik}', [LoginController::class, 'sso']);

Route::prefix('menu')->name('menu.')->middleware('auth')->group(function () {
    Route::resource('purchase-requests', PurchaseRequestController::class);
    Route::prefix('purchase-requests/status')->name('purchase-requests.status.')->controller(StatusPurchaseRequestController::class)->group(function () {
        Route::post('{purchase_request}/approve-manager', 'approveManager')->name('approve-manager');
        Route::post('{purchase_request}/hold-manager', 'holdManager')->name('hold-manager');
        Route::post('{purchase_request}/approve', 'approve')->name('approve');
        Route::post('{purchase_request}/reassign', 'reassign')->name('reassign');
    });

    Route::resource('leave-requests', LeaveRequestController::class)->except(['destroy']);
    Route::post('leave-requests/{leave_request}/approve', [StatusLeaveRequestController::class, 'approve'])->name('leave-requests.approve');
    Route::post('leave-requests/{leave_request}/reject', [StatusLeaveRequestController::class, 'reject'])->name('leave-requests.reject');
});

Route::prefix('master')->name('master.')->middleware(['auth', 'can:admin'])->group(function () {
    Route::resource('departments', DepartmentController::class)->except(['show', 'create', 'edit']);
    Route::resource('suppliers', SupplierController::class)->except(['show', 'create', 'edit']);
    Route::resource('items', ItemController::class)->except(['show', 'create', 'edit']);
});

Route::get('/api/master/departments/lookup', [DepartmentController::class, 'lookup'])->middleware('auth')->name('master.departments.lookup');

Route::prefix('report')->name('report.')->middleware('auth')->group(function () {
    Route::get('purchase-requests', [ReportController::class, 'indexPurchaseRequest'])->name('purchase-requests');
    Route::post('purchase-requests/export', [ReportController::class, 'exportPurchaseRequest'])->name('purchase-requests.export');
});

Route::prefix('get_data')->name('get_data.')->controller(GetDataController::class)->group(function () {
    Route::post('suppliers', 'suppliers')->name('suppliers');
    Route::post('items', 'items')->name('items');
});
