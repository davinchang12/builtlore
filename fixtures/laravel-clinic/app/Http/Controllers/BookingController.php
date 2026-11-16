<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreBookingRequest;
use App\Models\Booking;

class BookingController extends Controller
{
    public function index()
    {
        return view('booking.index', ['bookings' => auth()->user()->bookings]);
    }

    public function create()
    {
        return view('booking.create');
    }

    public function store(StoreBookingRequest $request)
    {
        $booking = Booking::create($request->validated());

        return redirect()->route('payment.show', $booking)->with('success', 'Booking created.');
    }

    public function show(Booking $booking)
    {
        return view('booking.show', compact('booking'));
    }

    public function cancel(Booking $booking)
    {
        if (! $booking->isCancellable()) {
            return back()->with('error', 'Bookings can only be cancelled until the day before.');
        }

        $booking->cancel();

        return to_route('booking.index')->with('status', 'Booking cancelled.');
    }
}
