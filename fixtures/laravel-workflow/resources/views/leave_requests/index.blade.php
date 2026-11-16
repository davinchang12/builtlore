@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.leave-requests.create') }}">New leave request</a>
    <div data-show-url="{{ route('menu.leave-requests.show', ':id') }}"></div>
@endsection
