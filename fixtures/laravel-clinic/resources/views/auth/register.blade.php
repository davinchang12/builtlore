@extends('layouts.app')

@section('content')
    <form method="POST" action="/register">
        @csrf
        <button>Register</button>
    </form>
@endsection
