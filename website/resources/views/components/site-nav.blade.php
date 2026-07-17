<nav class="sticky top-0 z-40 border-b border-white/5 bg-term-bg/70 backdrop-blur-md">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="{{ url('/') }}" class="font-mono text-lg font-semibold text-white">
            cindro<span class="text-term-green-400">_</span>
        </a>

        <div class="hidden items-center gap-8 font-mono text-sm text-gray-300 sm:flex">
            <a href="{{ route('pricing') }}" class="hover:text-white">pricing</a>
            <a href="{{ route('download') }}" class="hover:text-white">download</a>
            @auth
                <a href="{{ route('dashboard') }}" class="hover:text-white">dashboard</a>
            @else
                <a href="{{ route('login') }}" class="hover:text-white">login</a>
                <a href="{{ route('register') }}"
                   class="rounded-full bg-term-green-500 px-4 py-1.5 text-black hover:bg-term-green-400">
                    register
                </a>
            @endauth
        </div>
    </div>
</nav>
