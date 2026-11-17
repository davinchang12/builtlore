<?php

namespace App\Notifications;

use Illuminate\Notifications\Notification;

class PurchaseRequestSubmitted extends Notification
{
    public function via($notifiable): array
    {
        return ['mail', 'database'];
    }
}
