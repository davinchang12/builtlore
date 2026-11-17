@extends('layouts.app')

@section('content')
    @can('Menu Presentasi Approve')
        @if ($presentation->status == 'Revisi - Menunggu Approval')
            <form method="POST" action="{{ route('review.presentations.approve', $presentation->id) }}">@csrf<button>Approve</button></form>
            <form method="POST" action="{{ route('review.presentations.hold', $presentation->id) }}">@csrf<button>Hold</button></form>
        @endif
    @endcan
    @if ($presentation->status == 'Hold - Perlu Revisi')
        <form method="POST" action="{{ route('review.presentations.revise', $presentation->id) }}">@csrf<button>Revise</button></form>
    @endif
    <form method="POST" action="{{ route('review.presentations.delegate', $presentation->id) }}">@csrf<button>Delegate</button></form>
@endsection
