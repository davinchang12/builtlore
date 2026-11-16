@extends('layouts.app')

@section('content')
    <p>{{ $errors->first('payment') }}</p>
    <a href="{{ route('booking.index') }}">Back to my bookings</a>
@endsection
