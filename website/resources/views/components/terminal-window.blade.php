@props(['title' => 'cindro'])

<div {{ $attributes->merge(['class' => 'rounded-2xl glass-panel shadow-mac overflow-hidden']) }}>
    <div class="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-black/30">
        <span class="h-3 w-3 rounded-full bg-[#ff5f57]"></span>
        <span class="h-3 w-3 rounded-full bg-[#febc2e]"></span>
        <span class="h-3 w-3 rounded-full bg-[#28c840]"></span>
        <span class="ml-2 font-mono text-xs text-gray-400">{{ $title }}</span>
    </div>
    <div class="p-5 font-mono text-sm text-term-green-400">
        {{ $slot }}
    </div>
</div>
