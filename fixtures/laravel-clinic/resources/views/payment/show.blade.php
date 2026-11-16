@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('payment.pay', $booking) }}">
        @csrf
        <button name="method" value="card">Pay by card</button>
    </form>
@endsection
