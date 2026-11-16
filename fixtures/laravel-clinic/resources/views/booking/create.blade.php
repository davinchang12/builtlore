@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('booking.store') }}">
        @csrf
        @include('booking.partials.slot-picker')
        <button type="submit">Continue to payment</button>
    </form>
@endsection
