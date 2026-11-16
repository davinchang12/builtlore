<?php

namespace App\Http\Controllers;

use App\Models\PurchaseRequest;
use Illuminate\Http\Request;

class StatusPurchaseRequestController extends Controller
{
    public function approveManager(PurchaseRequest $purchaseRequest)
    {
        $purchaseRequest->status = 'APPROVED_MANAGER';
        $purchaseRequest->save();

        return back()->with('success', 'Approved by manager.');
    }

    public function holdManager(Request $request, PurchaseRequest $purchaseRequest)
    {
        $request->validate(['reason' => 'required']);
        $purchaseRequest->update(['status' => PurchaseRequest::STATUS_HOLD]);

        return back()->with('success', 'Request put on hold.');
    }

    public function approve(PurchaseRequest $purchaseRequest)
    {
        if ($purchaseRequest->status !== 'APPROVED_MANAGER') {
            return back()->with('error', 'Waiting for manager approval.');
        }
        $purchaseRequest->status = 3;
        $purchaseRequest->save();

        return redirect()->route('menu.purchase-requests.index')->with('success', 'Approved.');
    }

    public function reassign(Request $request, PurchaseRequest $purchaseRequest)
    {
        $purchaseRequest->update(['pic_nik' => $request->input('pic_nik')]);

        return back()->with('success', 'Reassigned.');
    }
}
