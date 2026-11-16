@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.leave-requests.edit', $leaveRequest) }}">Edit</a>
    <form method="POST" action="{{ route('menu.leave-requests.approve', $leaveRequest) }}">@csrf<button>Approve</button></form>
    <button onclick="reject({{ $leaveRequest->id }})">Reject</button>
    <script>
        function reject(id) {
            $.ajax({ url: '/menu/leave-requests/' + id + '/reject', type: 'POST' });
        }
    </script>
@endsection
