@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('menu.leave-requests.update', $leaveRequest) }}">@csrf @method('PUT')<button>Save</button></form>
@endsection
