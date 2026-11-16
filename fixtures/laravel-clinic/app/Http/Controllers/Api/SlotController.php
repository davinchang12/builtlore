<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Slot;

class SlotController extends Controller
{
    public function index()
    {
        return Slot::available()->get();
    }
}
