@extends('layouts.app')

@section('content')
    <p>How booking works.</p>
    <a href="{{ route('booking.create') }}">Start booking</a>
@endsection
