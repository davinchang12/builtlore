@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.purchase-requests.edit', $purchaseRequest) }}">Edit</a>
    <form method="POST" action="{{ route('menu.purchase-requests.status.approve-manager', $purchaseRequest) }}">@csrf<button>Approve (manager)</button></form>
    <form method="POST" action="{{ route('menu.purchase-requests.status.hold-manager', $purchaseRequest) }}">@csrf<button>Hold</button></form>
    <form method="POST" action="{{ route('menu.purchase-requests.status.approve', $purchaseRequest) }}">@csrf<button>Approve (procurement)</button></form>
    <form method="POST" action="{{ route('menu.purchase-requests.status.reassign', $purchaseRequest) }}">@csrf<button>Reassign PIC</button></form>
    <form method="POST" action="{{ route('menu.purchase-requests.destroy', $purchaseRequest) }}">
        @csrf
        @method('DELETE')
        <button>Delete</button>
    </form>
    {{-- <a href="{{ route('report.purchase-requests') }}">old report link</a> --}}
@endsection
