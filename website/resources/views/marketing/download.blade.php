<x-marketing-layout :title="'Download — Cindro'">
    <section class="mx-auto max-w-4xl px-6 py-16 text-center">
        <h1 class="font-mono text-4xl font-bold text-white">Download Cindro</h1>
        <p class="mt-4 text-gray-400">
            Linux is the first-class experience today. Windows is second-tier/experimental.
            No macOS build yet.
        </p>
        @if ($release)
            <p class="mt-2 font-mono text-sm text-term-green-400">latest release: {{ $release['version'] }}</p>
        @endif
    </section>

    @php
        $platforms = [
            'linux' => 'Linux (AppImage)',
            'windows' => 'Windows',
            'android' => 'Android',
            'ios' => 'iPhone (unsigned .ipa)',
        ];
    @endphp

    <section class="mx-auto max-w-4xl px-6 pb-24">
        @if ($release && count($release['platforms']))
            <div class="grid gap-6 sm:grid-cols-2">
                @foreach ($platforms as $key => $label)
                    @if (isset($release['platforms'][$key]))
                        <a href="{{ $release['platforms'][$key] }}"
                           class="glass-panel rounded-2xl p-6 shadow-mac hover:bg-white/10 transition">
                            <p class="font-mono text-lg text-white">{{ $label }}</p>
                            <p class="mt-2 text-sm text-term-green-400">download {{ $release['version'] }} →</p>
                        </a>
                    @endif
                @endforeach
            </div>
        @else
            <div class="glass-panel rounded-2xl p-8 text-center shadow-mac">
                <p class="text-gray-300">Download links unavailable right now.</p>
                <a href="https://github.com/CrazyMan28/jarvis/releases"
                   class="mt-4 inline-block font-mono text-term-green-400 hover:text-term-green-300 underline underline-offset-4">
                    see GitHub Releases directly →
                </a>
            </div>
        @endif
    </section>
</x-marketing-layout>
