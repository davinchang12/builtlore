@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('menu.purchase-requests.update', $purchaseRequest) }}">
        @csrf
        @method('PUT')
        <button>Save and resubmit</button>
    </form>
@endsection
