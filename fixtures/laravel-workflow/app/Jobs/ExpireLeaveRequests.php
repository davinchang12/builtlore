<?php

namespace App\Jobs;

use App\Enums\LeaveStatus;
use App\Models\LeaveRequest;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class ExpireLeaveRequests implements ShouldQueue
{
    use Queueable;

    public function handle(): void
    {
        LeaveRequest::where('status', LeaveStatus::Pending)
            ->where('from', '<', now())
            ->update(['status' => LeaveStatus::Rejected]);
    }
}
