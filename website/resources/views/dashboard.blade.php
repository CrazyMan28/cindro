<x-app-layout>
    <x-slot name="header">
        <h2 class="font-mono font-semibold text-xl text-white">Dashboard</h2>
    </x-slot>

    <div class="py-12">
        <div class="max-w-5xl mx-auto sm:px-6 lg:px-8 space-y-6">

            <x-terminal-window title="subscription.status">
                @if ($subscribed)
                    <p class="text-white">Subscribed — {{ $primaryLicense?->tier ?? 'active' }} tier.</p>
                @elseif ($onTrial)
                    <p class="text-white">Free trial — ends {{ $trialEndsAt->format('Y-m-d') }} ({{ $trialEndsAt->diffForHumans() }}).</p>
                @else
                    <p class="text-term-amber-400">No active subscription or trial.</p>
                    <a href="{{ route('pricing') }}" class="text-term-green-400 underline underline-offset-4">view pricing →</a>
                @endif

                @if ($subscribed)
                    <form method="GET" action="{{ route('billing-portal') }}" class="mt-4">
                        <button type="submit" class="rounded-full bg-white/10 px-4 py-2 text-white hover:bg-white/20">
                            Manage billing
                        </button>
                    </form>
                @endif
            </x-terminal-window>

            <x-terminal-window title="license.key">
                @if ($primaryLicense)
                    <p class="text-white">{{ $primaryLicense->key }}</p>
                    <p class="mt-1 text-xs text-gray-500">tier: {{ $primaryLicense->tier }} · status: {{ $primaryLicense->status }}</p>
                @else
                    <p class="text-gray-500">No license issued yet.</p>
                @endif
            </x-terminal-window>

            <x-terminal-window title="phone.numbers">
                @forelse ($phoneNumbers as $phone)
                    <p class="text-white">{{ $phone->e164_number ?? 'pending' }} ({{ $phone->provider }})</p>
                    <p class="mt-1 text-xs text-gray-500">
                        {{ $phone->minutes_used }}{{ $phone->minutes_cap ? '/'.$phone->minutes_cap : '' }} min ·
                        {{ $phone->sms_used }}{{ $phone->sms_cap ? '/'.$phone->sms_cap : '' }} sms
                    </p>
                @empty
                    <p class="text-gray-500">No hosted phone number yet (Pro and above).</p>
                @endforelse
            </x-terminal-window>

            <x-terminal-window title="download.sh">
                @if ($canDownload && $release)
                    <p class="text-white">latest release: {{ $release['version'] }}</p>
                    <div class="mt-2 space-y-1">
                        @foreach ($release['platforms'] as $platform => $url)
                            <a href="{{ $url }}" class="block text-term-green-400 underline underline-offset-4">{{ $platform }} →</a>
                        @endforeach
                    </div>
                @elseif ($canDownload)
                    <p class="text-gray-500">Download links unavailable right now — see the public <a href="{{ route('download') }}" class="text-term-green-400 underline">/download</a> page.</p>
                @else
                    <p class="text-term-amber-400">Downloads are gated to an active trial or subscription.</p>
                @endif
            </x-terminal-window>

        </div>
    </div>
</x-app-layout>
