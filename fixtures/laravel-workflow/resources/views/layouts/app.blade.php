<!DOCTYPE html>
<html>
<body>
    <nav>
        <a href="{{ route('dashboard') }}">Dashboard</a>
        <a href="{{ route('menu.purchase-requests.index') }}">Purchase requests</a>
        <a href="{{ route('menu.leave-requests.index') }}">Leave requests</a>
    </nav>
    @yield('content')
    @stack('scripts')
</body>
</html>
