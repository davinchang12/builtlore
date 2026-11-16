@extends('layouts.app')

@section('content')
    <a href="{{ route('admin.vaccines.create') }}">Add vaccine</a>
    @foreach ($vaccines as $vaccine)
        <a href="{{ route('admin.vaccines.edit', $vaccine) }}">Edit</a>
        <form method="POST" action="{{ route('admin.vaccines.destroy', $vaccine) }}">
            @csrf
            @method('DELETE')
            <button>Remove</button>
        </form>
    @endforeach
@endsection
