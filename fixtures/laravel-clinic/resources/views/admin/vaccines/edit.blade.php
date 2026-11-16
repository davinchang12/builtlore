@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('admin.vaccines.update', $vaccine) }}">
        @csrf
        <input type="hidden" name="_method" value="PUT">
        <button>Save changes</button>
    </form>
@endsection
