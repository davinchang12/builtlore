<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StorePurchaseRequestRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'title' => 'required|string|max:150',
            'item_id' => ['required', 'exists:items,id'],
            'qty' => 'required|integer|min:1',
            'priority' => ['nullable', Rule::in(['low', 'normal', 'urgent'])],
            'attachment' => 'nullable|file|mimes:pdf,jpg,png|max:2048',
        ];
    }
}
