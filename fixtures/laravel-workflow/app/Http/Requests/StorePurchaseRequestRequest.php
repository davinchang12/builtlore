<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StorePurchaseRequestRequest extends FormRequest
{
    public function rules(): array
    {
        return ['item_id' => 'required', 'qty' => 'required|integer|min:1'];
    }
}
