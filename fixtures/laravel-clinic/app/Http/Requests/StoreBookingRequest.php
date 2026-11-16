<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreBookingRequest extends FormRequest
{
    public function rules(): array
    {
        return ['vaccine_id' => 'required|exists:vaccines,id', 'slot_id' => 'required|exists:slots,id'];
    }
}
