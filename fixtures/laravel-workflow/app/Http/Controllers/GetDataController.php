<?php

namespace App\Http\Controllers;

use App\Models\Item;
use App\Models\Supplier;
use Illuminate\Http\Request;

class GetDataController extends Controller
{
    public function suppliers()
    {
        return response()->json(Supplier::orderBy('name')->get());
    }

    public function items(Request $request)
    {
        return response()->json(Item::where('supplier_id', $request->input('supplier_id'))->get());
    }
}
