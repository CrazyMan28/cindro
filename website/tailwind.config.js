import defaultTheme from 'tailwindcss/defaultTheme';
import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: [
        './vendor/laravel/framework/src/Illuminate/Pagination/resources/views/*.blade.php',
        './storage/framework/views/*.php',
        './resources/views/**/*.blade.php',
    ],

    theme: {
        extend: {
            colors: {
                term: {
                    bg: '#0b0f0d',
                    panel: '#11161366',
                    border: '#1f2a24',
                    green: {
                        400: '#4ade80',
                        500: '#22c55e',
                        600: '#16a34a',
                    },
                    amber: {
                        400: '#fbbf24',
                        500: '#f59e0b',
                    },
                },
            },
            fontFamily: {
                mono: ['"JetBrains Mono"', '"SF Mono"', '"Fira Code"', ...defaultTheme.fontFamily.mono],
                sans: ['Inter', ...defaultTheme.fontFamily.sans],
            },
            boxShadow: {
                mac: '0 20px 50px -12px rgba(0, 0, 0, 0.55)',
            },
        },
    },

    plugins: [forms],
};
