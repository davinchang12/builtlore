<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class AuthController extends Controller
{
    public function showLogin()
    {
        return view('auth.login');
    }

    public function login(Request $request)
    {
        $credentials = $request->validate(['email' => 'required|email', 'password' => 'required']);

        if (! Auth::attempt($credentials)) {
            return back()->withErrors(['email' => 'These credentials do not match our records.']);
        }

        return redirect()->intended(route('booking.index'));
    }

    public function showRegister()
    {
        return view('auth.register');
    }

    public function register(Request $request)
    {
        $data = $request->validate(['name' => 'required', 'email' => 'required|email|unique:users', 'password' => 'required|min:8']);
        Auth::login(User::create($data));

        return redirect()->route('booking.create');
    }

    public function logout(Request $request)
    {
        Auth::logout();

        return redirect('/');
    }
}
