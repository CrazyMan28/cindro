<x-marketing-layout :title="'Pricing — Cindro'">
    <section class="mx-auto max-w-6xl px-6 py-16 text-center">
        <h1 class="font-mono text-4xl font-bold text-white">Pricing</h1>
        <p class="mt-4 text-gray-400">Bring your own AI provider key on every tier. No surprise usage bills.</p>
    </section>

    <section class="mx-auto max-w-6xl px-6 pb-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
        @foreach ($tiers as $key => $tier)
            <x-pricing-card
                :tier="$key"
                :label="$tier['label']"
                :price="$tier['monthly']"
                :suffix="($tier['per_seat'] ?? false) ? '/seat/mo' : '/mo'"
                :highlight="$key === 'pro'"
                :ctaLabel="$key === 'trial' ? 'Start free trial' : ($key === 'enterprise' ? 'Contact sales' : 'Subscribe')"
                :ctaUrl="$key === 'trial' ? route('register', ['plan' => 'trial']) : ($key === 'enterprise' ? 'mailto:sales@cindro.dev' : route('checkout.subscribe', $key))"
            >
                @if ($key === 'business')
                    <p>3-seat minimum</p>
                @endif
                @if ($key === 'trial')
                    <p>14 days, no credit card</p>
                @endif
            </x-pricing-card>
        @endforeach
    </section>

    <section class="mx-auto max-w-6xl px-6 pb-24 overflow-x-auto">
        <table class="w-full font-mono text-sm border-collapse">
            <thead>
                <tr class="border-b border-white/10 text-left text-gray-400">
                    <th class="py-3 pr-4">Feature</th>
                    @foreach ($tiers as $key => $tier)
                        <th class="py-3 px-4 text-center">{{ $tier['label'] }}</th>
                    @endforeach
                </tr>
            </thead>
            <tbody>
                @foreach ($rows as $row)
                    <tr class="border-b border-white/5 odd:bg-white/[0.02]">
                        <td class="py-3 pr-4 text-gray-300">{{ $row['label'] }}</td>
                        @foreach (array_keys($tiers) as $tierKey)
                            <td class="py-3 px-4 text-center">
                                @php $value = $row[$tierKey] ?? false; @endphp
                                @if (is_bool($value))
                                    @if ($value)
                                        <span class="text-term-green-400">✓</span>
                                    @else
                                        <span class="text-term-amber-500">—</span>
                                    @endif
                                @else
                                    <span class="text-gray-300 text-xs">{{ $value }}</span>
                                @endif
                            </td>
                        @endforeach
                    </tr>
                @endforeach
            </tbody>
        </table>
    </section>
</x-marketing-layout>
