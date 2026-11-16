@extends('layouts.app')

@section('content')
    <form method="POST" action="{{ route('report.purchase-requests.export') }}">@csrf<button>Export to Excel</button></form>
@endsection
