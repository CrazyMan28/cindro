<footer class="border-t border-white/5 mt-24">
    <div class="mx-auto max-w-6xl px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs text-gray-500">
        <span>&copy; {{ date('Y') }} Cindro. All rights reserved.</span>
        <div class="flex gap-6">
            <a href="{{ route('terms') }}" class="hover:text-gray-300">terms</a>
            <a href="{{ route('privacy') }}" class="hover:text-gray-300">privacy</a>
            <a href="https://github.com/CrazyMan28/jarvis" class="hover:text-gray-300">github</a>
        </div>
    </div>
</footer>
