<?php

namespace App\Http\Controllers\Master;

use App\Http\Controllers\Controller;
use App\Models\Department;
use Illuminate\Http\Request;

class DepartmentController extends Controller
{
    public function index()
    {
        return view('master.departments.index');
    }

    public function lookup()
    {
        return response()->json(Department::orderBy('name')->get(['id', 'name']));
    }

    public function store(Request $request)
    {
        Department::create($request->validate(['name' => 'required']));

        return back()->with('success', 'Saved.');
    }

    public function update(Request $request, Department $department)
    {
        $department->update($request->only('name'));

        return response()->json(['ok' => true]);
    }

    public function destroy(Department $department)
    {
        $department->delete();

        return back();
    }
}
