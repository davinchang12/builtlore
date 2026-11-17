<?php

use App\Jobs\ExpireLeaveRequests;
use Illuminate\Support\Facades\Schedule;

Schedule::command('purchase-requests:remind')->weekdays()->dailyAt('08:00');
Schedule::job(new ExpireLeaveRequests)->hourly()->withoutOverlapping();
Schedule::command('model:prune')->daily();
