<?php

namespace App\Http\Controllers;

use App\Models\Ticket;

class TicketController extends Controller
{
    public function show(Ticket $ticket)
    {
        return view('tickets.show', compact('ticket'));
    }
}
