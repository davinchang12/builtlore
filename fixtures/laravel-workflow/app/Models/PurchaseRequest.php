<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PurchaseRequest extends Model
{
    // Two developers, two styles: constants for some states, literals and numbers elsewhere.
    const STATUS_WAITING_MANAGER = 'WAITING_MANAGER';
    const STATUS_HOLD = 'HOLD';

    protected $fillable = ['title', 'amount', 'supplier_id', 'item_id', 'pic_nik', 'manager_nik', 'status'];

    public static $statusLabels = [
        'WAITING_MANAGER' => 'Waiting for manager',
        'APPROVED_MANAGER' => 'Approved by manager',
        'HOLD' => 'On hold',
        3 => 'Approved by procurement',
    ];
}
