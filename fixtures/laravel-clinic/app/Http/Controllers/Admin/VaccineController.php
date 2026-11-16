<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\Vaccine;
use Illuminate\Http\Request;

class VaccineController extends Controller
{
    public function index()
    {
        return view('admin.vaccines.index', ['vaccines' => Vaccine::all()]);
    }

    public function create()
    {
        return view('admin.vaccines.create');
    }

    public function store(Request $request)
    {
        Vaccine::create($request->validate(['name' => 'required', 'stock' => 'integer']));

        return redirect()->route('admin.vaccines.index')->with('success', 'Vaccine added.');
    }

    public function edit(Vaccine $vaccine)
    {
        return view('admin.vaccines.edit', compact('vaccine'));
    }

    public function update(Request $request, Vaccine $vaccine)
    {
        $vaccine->update($request->validate(['name' => 'required', 'stock' => 'integer']));

        return to_route('admin.vaccines.index');
    }

    public function destroy(Vaccine $vaccine)
    {
        $vaccine->delete();

        return back()->with('success', 'Vaccine removed.');
    }
}
