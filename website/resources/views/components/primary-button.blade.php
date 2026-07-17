<button {{ $attributes->merge(['type' => 'submit', 'class' => 'inline-flex items-center px-4 py-2 bg-term-green-500 border border-transparent rounded-full font-mono font-semibold text-xs text-black uppercase tracking-widest hover:bg-term-green-400 focus:outline-none focus:ring-2 focus:ring-term-green-500 focus:ring-offset-2 focus:ring-offset-term-bg transition ease-in-out duration-150']) }}>
    {{ $slot }}
</button>
