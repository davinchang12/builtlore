@extends('layouts.app')

@section('content')
    <a href="{{ route('booking.create') }}">New booking</a>
    @foreach ($bookings as $booking)
        <a href="{{ route('booking.show', $booking) }}">{{ $booking->vaccine->name }}</a>
    @endforeach
@endsection
