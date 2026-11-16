@extends('layouts.app')

@section('content')
    <a href="{{ route('menu.purchase-requests.create') }}">New purchase request</a>
    <a href="{{ route('menu.leave-requests.create') }}">New leave request</a>
    <a href="{{ route('report.purchase-requests') }}">Reports</a>
@endsection
