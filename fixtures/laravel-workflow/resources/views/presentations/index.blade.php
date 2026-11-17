@extends('layouts.app')

@section('content')
    <a href="{{ route('review.presentations.show', 1) }}">Open</a>
    <form method="POST" action="{{ route('review.presentations.store') }}">@csrf<button>New</button></form>
@endsection
