@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('menu.purchase-requests.store') }}">
        @csrf
        @include('purchase_requests.partials.item-picker')
        <button>Submit request</button>
    </form>
@endsection
