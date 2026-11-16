<?php

namespace App\Http\Controllers\Master;

use App\Http\Controllers\Controller;
use App\Models\Supplier;
use Illuminate\Http\Request;

class SupplierController extends Controller
{
    public function index()
    {
        return view('master.suppliers.index');
    }

    public function store(Request $request)
    {
        Supplier::create($request->validate(['name' => 'required']));

        return back();
    }

    public function update(Request $request, Supplier $supplier)
    {
        $supplier->update($request->validate(['name' => 'required']));

        return back();
    }

    public function destroy(Supplier $supplier)
    {
        $supplier->delete();

        return back();
    }
}
