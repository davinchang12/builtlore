@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.leave-requests.edit', $leaveRequest) }}">Edit</a>
    <form method="POST" action="{{ route('menu.leave-requests.approve', $leaveRequest) }}">@csrf<button>Approve</button></form>
    <form method="POST" action="{{ route('menu.leave-requests.reject', $leaveRequest) }}">@csrf<button>Reject</button></form>
@endsection
