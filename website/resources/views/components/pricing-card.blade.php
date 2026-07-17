@props(['tier', 'label', 'price' => null, 'suffix' => '/mo', 'highlight' => false, 'ctaLabel' => 'Get started', 'ctaUrl' => '#'])

<div {{ $attributes->merge(['class' => 'rounded-2xl glass-panel shadow-mac overflow-hidden flex flex-col ' . ($highlight ? 'ring-2 ring-term-green-500/60' : '')]) }}>
    <div class="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-black/30">
        <span class="h-3 w-3 rounded-full bg-[#ff5f57]"></span>
        <span class="h-3 w-3 rounded-full bg-[#febc2e]"></span>
        <span class="h-3 w-3 rounded-full bg-[#28c840]"></span>
        <span class="ml-2 font-mono text-xs text-gray-400">{{ $tier }}.plan</span>
        @if ($highlight)
            <span class="ml-auto rounded-full bg-term-green-500/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-term-green-400">Most popular</span>
        @endif
    </div>

    <div class="p-6 flex flex-col grow">
        <h3 class="font-mono text-lg font-semibold text-white">{{ $label }}</h3>

        <p class="mt-3 font-mono">
            @if ($price === null)
                <span class="text-3xl font-bold text-white">Custom</span>
            @elseif ($price === 0)
                <span class="text-3xl font-bold text-white">Free</span>
            @else
                <span class="text-3xl font-bold text-white">${{ $price }}</span>
                <span class="text-sm text-gray-400">{{ $suffix }}</span>
            @endif
        </p>

        <div class="mt-4 text-sm text-gray-400 space-y-2 grow">
            {{ $slot }}
        </div>

        <a href="{{ $ctaUrl }}"
           class="mt-6 inline-flex items-center justify-center rounded-full px-4 py-2 font-mono text-sm font-medium transition
                  {{ $highlight ? 'bg-term-green-500 text-black hover:bg-term-green-400' : 'bg-white/10 text-white hover:bg-white/20' }}">
            {{ $ctaLabel }}
        </a>
    </div>
</div>
