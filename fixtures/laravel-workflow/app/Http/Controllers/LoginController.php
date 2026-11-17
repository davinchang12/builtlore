<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Http;

class LoginController extends Controller
{
    public function sso(string $nik)
    {
        $user = Http::get(env('EPORTAL_URL') . '/api/validate/' . $nik)->json();
        Auth::loginUsingId($user['id']);

        return redirect()->route('dashboard');
    }
}
