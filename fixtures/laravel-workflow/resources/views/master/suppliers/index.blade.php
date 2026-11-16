@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('master.suppliers.store') }}">@csrf<button>Add</button></form>
    <form method="POST" action="{{ route('master.suppliers.update', 1) }}">@csrf @method('PUT')<button>Save</button></form>
    <form method="POST" action="{{ route('master.suppliers.destroy', 1) }}">@csrf @method('DELETE')<button>Delete</button></form>
@endsection
