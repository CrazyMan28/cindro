<?php

namespace App\Http\Controllers;

use App\Services\GitHubReleaseService;

class DownloadController extends Controller
{
    public function index(GitHubReleaseService $releases)
    {
        return view('marketing.download', [
            'release' => $releases->latestRelease(),
        ]);
    }
}
