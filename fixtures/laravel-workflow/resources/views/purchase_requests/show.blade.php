@extends('layouts.app')

@section('content')
    @if ($purchaseRequest->status == 'HOLD')
        <a href="{{ route('menu.purchase-requests.edit', $purchaseRequest) }}">Edit</a>
    @endif
    @if ($purchaseRequest->status == \App\Models\PurchaseRequest::STATUS_WAITING_MANAGER && auth()->user()->nik == $purchaseRequest->manager_nik)
        <form method="POST" action="{{ route('menu.purchase-requests.status.approve-manager', $purchaseRequest) }}">@csrf<button>Approve (manager)</button></form>
        <form method="POST" action="{{ route('menu.purchase-requests.status.hold-manager', $purchaseRequest) }}">@csrf<button>Hold</button></form>
    @elseif ($purchaseRequest->status === 'APPROVED_MANAGER')
        <form method="POST" action="{{ route('menu.purchase-requests.status.approve', $purchaseRequest) }}">@csrf<button>Approve (procurement)</button></form>
    @endif
    @role('admin')
        <form method="POST" action="{{ route('menu.purchase-requests.status.reassign', $purchaseRequest) }}">@csrf<button>Reassign PIC</button></form>
    @endrole
    <form method="POST" action="{{ route('menu.purchase-requests.destroy', $purchaseRequest) }}">
        @csrf
        @method('DELETE')
        <button>Delete</button>
    </form>
    {{-- <a href="{{ route('report.purchase-requests') }}">old report link</a> --}}
@endsection
