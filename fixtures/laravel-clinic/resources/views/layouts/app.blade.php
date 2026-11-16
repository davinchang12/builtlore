<!DOCTYPE html>
<html>
<body>
    <nav>
        <a href="{{ route('home') }}">Home</a>
        <a href="{{ route('booking.index') }}">My bookings</a>
        <a href="{{ route('about') }}">About</a>
        <form method="POST" action="{{ route('logout') }}">@csrf<button>Log out</button></form>
    </nav>
    @yield('content')
</body>
</html>
