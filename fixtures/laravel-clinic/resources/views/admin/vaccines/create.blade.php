@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('admin.vaccines.store') }}">
        @csrf
        <button>Save</button>
    </form>
@endsection
