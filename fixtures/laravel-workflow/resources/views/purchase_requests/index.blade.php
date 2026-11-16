@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.purchase-requests.create') }}">New request</a>
    <table id="requests"></table>
@endsection

@push('scripts')
<script>
    $('#requests').DataTable({
        ajax: "{{ route('menu.purchase-requests.index') }}",
        columns: [{
            data: 'id',
            render: function (id) {
                var url = "{{ route('menu.purchase-requests.show', ':id') }}".replace(':id', id);
                return '<a href="' + url + '">Detail</a>';
            }
        }]
    });
</script>
@endpush
