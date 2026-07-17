@props(['value'])

<label {{ $attributes->merge(['class' => 'block font-mono font-medium text-sm text-gray-400']) }}>
    {{ $value ?? $slot }}
</label>
