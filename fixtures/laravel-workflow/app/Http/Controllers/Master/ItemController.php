<?php

namespace App\Http\Controllers\Master;

use App\Http\Controllers\Controller;
use App\Models\Item;
use Illuminate\Http\Request;

class ItemController extends Controller
{
    public function index()
    {
        return view('master.items.index');
    }

    public function store(Request $request)
    {
        Item::create($request->validate(['name' => 'required']));

        return back();
    }

    public function update(Request $request, Item $item)
    {
        $item->update($request->validate(['name' => 'required']));

        return back();
    }

    public function destroy(Item $item)
    {
        $item->delete();

        return back();
    }
}
