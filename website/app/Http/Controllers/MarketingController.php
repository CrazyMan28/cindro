<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Support\PricingCatalog;

class MarketingController extends Controller
{
    public function landing()
    {
        return view('marketing.landing', [
            'bullets' => PricingCatalog::marketingBullets(),
            'foundingMembersClaimed' => User::foundingMembersClaimedCount(),
            'foundingMemberCap' => config('cindro.founding_member_cap'),
        ]);
    }

    public function pricing()
    {
        return view('marketing.pricing', [
            'tiers' => config('cindro.tiers'),
            'rows' => PricingCatalog::featureRows(),
        ]);
    }

    public function terms()
    {
        return view('marketing.terms');
    }

    public function privacy()
    {
        return view('marketing.privacy');
    }
}
