@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('login') }}">
        @csrf
        <button>Log in</button>
    </form>
    <a href="{{ route('register') }}">Create an account</a>
@endsection
