<?php

namespace App\Http\Controllers;

use App\Exports\PurchaseRequestExport;
use Maatwebsite\Excel\Facades\Excel;

class ReportController extends Controller
{
    public function indexPurchaseRequest()
    {
        return view('reports.purchase_requests');
    }

    public function exportPurchaseRequest()
    {
        return Excel::download(new PurchaseRequestExport, 'purchase-requests.xlsx');
    }
}
