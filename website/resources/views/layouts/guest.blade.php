<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="dark">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="csrf-token" content="{{ csrf_token() }}">

        <title>{{ config('app.name', 'Cindro') }}</title>

        @vite(['resources/css/app.css', 'resources/js/app.js'])
    </head>
    <body class="font-sans text-gray-200 antialiased">
        <div class="min-h-screen flex flex-col justify-center items-center px-4">
            <a href="/" class="font-mono text-xl font-semibold text-white mb-6">
                cindro<span class="text-term-green-400">_</span>
            </a>

            <x-terminal-window :title="$authTitle ?? 'auth.sh'" class="w-full sm:max-w-md">
                <div class="font-sans text-sm text-gray-200 [&_input]:bg-black/30 [&_input]:border-white/10 [&_input]:text-gray-100 [&_input]:rounded-lg [&_label]:text-gray-400 [&_a]:text-term-green-400">
                    {{ $slot }}
                </div>
            </x-terminal-window>
        </div>
    </body>
</html>
