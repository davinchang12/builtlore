<?php

namespace App\Http\Controllers;

use App\Http\Requests\StorePurchaseRequestRequest;
use App\Models\PurchaseRequest;
use Illuminate\Http\Request;
use Yajra\DataTables\Facades\DataTables;

class PurchaseRequestController extends Controller
{
    public function index(Request $request)
    {
        if ($request->ajax()) {
            return DataTables::of(PurchaseRequest::query())->make(true);
        }

        return view('purchase_requests.index');
    }

    public function create()
    {
        return view('purchase_requests.create');
    }

    public function store(StorePurchaseRequestRequest $request)
    {
        $pr = PurchaseRequest::create($request->validated() + ['status' => PurchaseRequest::STATUS_WAITING_MANAGER]);

        return redirect()->route('menu.purchase-requests.show', $pr)->with('success', 'Request submitted.');
    }

    public function show(PurchaseRequest $purchaseRequest)
    {
        return view('purchase_requests.show', compact('purchaseRequest'));
    }

    public function edit(PurchaseRequest $purchaseRequest)
    {
        return view('purchase_requests.edit', compact('purchaseRequest'));
    }

    public function update(StorePurchaseRequestRequest $request, PurchaseRequest $purchaseRequest)
    {
        $purchaseRequest->update($request->validated() + ['status' => PurchaseRequest::STATUS_WAITING_MANAGER]);

        return to_route('menu.purchase-requests.show', $purchaseRequest);
    }

    public function destroy(PurchaseRequest $purchaseRequest)
    {
        $purchaseRequest->delete();

        return redirect()->route('menu.purchase-requests.index')->with('success', 'Deleted.');
    }
}
