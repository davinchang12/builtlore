<?php

namespace App\Console\Commands;

use App\Mail\WaitingApprovalReminder;
use App\Models\PurchaseRequest;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Mail;

class RemindManagers extends Command
{
    protected $signature = 'purchase-requests:remind';

    protected $description = 'Email managers about purchase requests waiting more than 2 days';

    public function handle(): void
    {
        foreach (PurchaseRequest::where('status', PurchaseRequest::STATUS_WAITING_MANAGER)->get() as $pr) {
            Mail::to($pr->manager_email)->send(new WaitingApprovalReminder($pr));
        }
    }
}
