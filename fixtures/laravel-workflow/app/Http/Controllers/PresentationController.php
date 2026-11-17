<?php

namespace App\Http\Controllers;

use App\Models\Presentation;
use App\Models\PresentationHistory;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class PresentationController extends Controller
{
    public function index()
    {
        return view('presentations.index');
    }

    public function show($id)
    {
        $presentation = Presentation::findOrFail($id);

        return view('presentations.show', compact('presentation'));
    }

    public function store(Request $request)
    {
        $data = ['title' => $request->title];
        $data['status'] = 'Revisi - Menunggu Approval';
        $presentation = Presentation::create($data);
        PresentationHistory::create(['presentation_id' => $presentation->id, 'status' => $data['status']]);

        return redirect()->route('review.presentations.index');
    }

    public function approve($id)
    {
        $status = 'Finished';
        DB::connection('sqlsrv')->table('presentasi')->where('id', $id)->update(['status' => $status]);
        PresentationHistory::create(['presentation_id' => $id, 'status' => 'Approved']);

        return back()->with('success', 'Approved');
    }

    public function hold($id)
    {
        DB::update("update presentasi set status = 'Hold - Perlu Revisi' where id = ?", [$id]);

        return back();
    }

    public function decide(Request $request, $id)
    {
        Presentation::where('id', $id)->update(['status' => $request->action == 'approve' ? 'Finished' : 'Hold - Perlu Revisi']);

        return back();
    }

    public function delegate(Request $request, $id)
    {
        DB::statement('EXEC sp_delegate_presentasi ?, ?', [$id, $request->nik]);

        return back();
    }

    public function revise(Request $request, $id)
    {
        $presentation = Presentation::findOrFail($id);
        $presentation->status = $request->status;
        $presentation->save();

        return back();
    }
}
