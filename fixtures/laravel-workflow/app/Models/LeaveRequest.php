<?php

namespace App\Models;

use App\Enums\LeaveStatus;
use Illuminate\Database\Eloquent\Model;

class LeaveRequest extends Model
{
    protected $fillable = ['from', 'to', 'reason', 'status'];

    protected $attributes = ['status' => 'pending'];

    protected $casts = ['status' => LeaveStatus::class];
}
