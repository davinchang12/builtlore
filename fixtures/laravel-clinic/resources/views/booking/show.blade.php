@extends('layouts.app')

@section('content')
    <a href="{{ route('payment.show', $booking) }}">Pay now</a>
    <form method="POST" action="{{ route('booking.cancel', $booking) }}">
        @csrf
        @method('DELETE')
        <button>Cancel booking</button>
    </form>
@endsection
