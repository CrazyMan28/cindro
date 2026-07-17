@props(['disabled' => false])

<input @disabled($disabled) {{ $attributes->merge(['class' => 'bg-black/30 border-white/10 text-gray-100 focus:border-term-green-500 focus:ring-term-green-500 rounded-lg shadow-sm']) }}>
