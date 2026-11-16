<?php

namespace App\Http\Controllers;

use App\Models\LeaveRequest;
use Illuminate\Http\Request;

class LeaveRequestController extends Controller
{
    public function index()
    {
        return view('leave_requests.index');
    }

    public function create()
    {
        return view('leave_requests.create');
    }

    public function store(Request $request)
    {
        $leave = LeaveRequest::create($request->validate(['from' => 'required|date', 'to' => 'required|date']));

        return to_route('menu.leave-requests.show', $leave);
    }

    public function show(LeaveRequest $leaveRequest)
    {
        return view('leave_requests.show', compact('leaveRequest'));
    }

    public function edit(LeaveRequest $leaveRequest)
    {
        return view('leave_requests.edit', compact('leaveRequest'));
    }

    public function update(Request $request, LeaveRequest $leaveRequest)
    {
        $leaveRequest->update($request->validate(['from' => 'required|date', 'to' => 'required|date']));

        return to_route('menu.leave-requests.show', $leaveRequest);
    }
}
