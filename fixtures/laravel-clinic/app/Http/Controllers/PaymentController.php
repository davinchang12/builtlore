<?php

namespace App\Http\Controllers;

use App\Exceptions\PaymentFailed;
use App\Models\Booking;
use App\Services\PaymentGateway;
use Illuminate\Http\Request;

class PaymentController extends Controller
{
    public function show(Booking $booking)
    {
        return view('payment.show', compact('booking'));
    }

    public function pay(Request $request, Booking $booking, PaymentGateway $gateway)
    {
        $request->validate(['method' => 'required|in:card,ewallet']);

        try {
            $ticket = $gateway->charge($booking, $request->input('method'));
        } catch (PaymentFailed $e) {
            return redirect()->route('payment.failed')->withErrors(['payment' => $e->getMessage()]);
        }

        return redirect()->route('tickets.show', $ticket);
    }

    public function failed()
    {
        return view('payment.failed');
    }
}
