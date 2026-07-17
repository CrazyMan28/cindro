<x-marketing-layout :title="'Cindro — the AI co-worker that actually uses your computer'">
    @if ($foundingMemberCap && $foundingMembersClaimed < $foundingMemberCap)
        <div class="border-b border-term-amber-500/20 bg-term-amber-500/5">
            <p class="mx-auto max-w-6xl px-6 py-2 font-mono text-xs text-term-amber-400">
                <span class="blinking-cursor">$</span>
                founding_member --status: {{ $foundingMembersClaimed }}/{{ $foundingMemberCap }} claimed — 50% off for life
            </p>
        </div>
    @endif

    <section class="mx-auto max-w-6xl px-6 py-20 grid gap-12 lg:grid-cols-2 items-center">
        <div>
            <h1 class="font-mono text-4xl sm:text-5xl font-bold text-white leading-tight">
                One AI co-worker.<br>
                <span class="text-term-green-400">Every device you own.</span>
            </h1>
            <p class="mt-6 text-lg text-gray-400 leading-relaxed">
                Cindro drives your mouse, keyboard, and screen — on Linux, Windows, Android, Chrome,
                and iPhone — and calls or texts you back from its own phone number. Built for
                solo devs, homelabbers, and self-hosters who live in a terminal.
            </p>
            <div class="mt-8 flex flex-wrap gap-4 font-mono text-sm">
                <a href="{{ route('register') }}" class="rounded-full bg-term-green-500 px-6 py-3 font-medium text-black hover:bg-term-green-400">
                    Start 14-day trial — no card
                </a>
                <a href="{{ route('pricing') }}" class="rounded-full bg-white/10 px-6 py-3 font-medium text-white hover:bg-white/20">
                    See pricing
                </a>
            </div>
        </div>

        <x-terminal-window title="cindro — chat">
            <p><span class="text-gray-500">$</span> cindro chat</p>
            <p class="mt-2 text-gray-300">&gt; watch my Proxmox cluster and text me if a VM goes down</p>
            <p class="mt-2">[cindro] workload-manager agent attached. monitoring 6 VMs...</p>
            <p class="mt-2 text-term-amber-400">[cindro] vm-104 cpu 97% for 8m — restarting service, will report back</p>
            <p class="mt-4"><span class="blinking-cursor">▍</span></p>
        </x-terminal-window>
    </section>

    <section class="mx-auto max-w-6xl px-6 pb-24">
        <h2 class="font-mono text-sm uppercase tracking-widest text-gray-500 mb-8">What's out of the box</h2>
        <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            @foreach ($bullets as $bullet)
                <x-feature-card :title="$bullet['title']" :description="$bullet['description']" />
            @endforeach
        </div>
    </section>

    <section class="mx-auto max-w-6xl px-6 pb-24 text-center">
        <a href="{{ route('download') }}" class="font-mono text-term-green-400 hover:text-term-green-300 underline underline-offset-4">
            → download Cindro for your platform
        </a>
    </section>
</x-marketing-layout>
