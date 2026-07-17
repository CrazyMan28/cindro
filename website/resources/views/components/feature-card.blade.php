@props(['title', 'description'])

<div {{ $attributes->merge(['class' => 'glass-panel rounded-2xl p-6 shadow-mac']) }}>
    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-term-green-500/10 text-term-green-400 font-mono text-lg">
        &gt;_
    </div>
    <h3 class="mt-4 font-mono text-base font-semibold text-white">{{ $title }}</h3>
    <p class="mt-2 text-sm leading-relaxed text-gray-400">{{ $description }}</p>
</div>
