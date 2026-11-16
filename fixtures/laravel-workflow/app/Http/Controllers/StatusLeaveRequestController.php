<?php

namespace App\Http\Controllers;

use App\Enums\LeaveStatus;
use App\Models\LeaveRequest;

class StatusLeaveRequestController extends Controller
{
    public function approve(LeaveRequest $leaveRequest)
    {
        $this->authorize('approve', $leaveRequest);
        $leaveRequest->update(['status' => LeaveStatus::Approved]);

        return redirect()->route('menu.leave-requests.index');
    }

    public function reject(LeaveRequest $leaveRequest)
    {
        $leaveRequest->update(['status' => LeaveStatus::Rejected]);

        return redirect()->route('menu.leave-requests.index');
    }
}
