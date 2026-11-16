@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('master.departments.store') }}">@csrf<button>Add</button></form>
    <form method="POST" action="{{ route('master.departments.destroy', 1) }}">@csrf @method('DELETE')<button>Delete</button></form>
    <script>
        $.get('/api/master/departments/lookup', function (rows) { render(rows); });
        function rename(id, name) {
            $.ajax({ url: "{{ route('master.departments.update', ':id') }}".replace(':id', id), type: 'PUT', data: { name: name } });
        }
    </script>
@endsection
