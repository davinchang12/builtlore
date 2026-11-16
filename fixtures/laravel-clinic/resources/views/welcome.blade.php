@extends('layouts.app')

@section('content')
    <h1>Get vaccinated in minutes</h1>
    <a href="{{ route('booking.create') }}">Book a vaccine</a>
    <a href="{{ route('login') }}">Log in</a>
@endsection
