@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('menu.leave-requests.store') }}">@csrf<button>Submit</button></form>
@endsection
