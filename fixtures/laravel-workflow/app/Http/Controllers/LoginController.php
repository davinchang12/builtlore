<?php

namespace App\Http\Controllers;


class LoginController extends Controller
{
    public function sso(string $nik)
    {
        return redirect()->route('dashboard');
    }
}
