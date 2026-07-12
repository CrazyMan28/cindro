package com.cindro.app.widget

/**
 * Size-tiered home-screen providers. Android gives **no per-pin size API** —
 * `requestPinAppWidget` always uses the chosen *provider's* default cell. So to make
 * the pin size adapt to a widget's content, we expose several providers, each with
 * its OWN default cell (static per provider, which the launcher honors), and
 * [WidgetPinHelper] picks the one that best fits the content's measured height.
 *
 * All behavior — binding, live updates, rendering — is inherited from
 * [JarvisWidgetProvider]; these subclasses exist only to carry a different
 * `appwidget-provider` meta-data (size) in the manifest.
 */
class JarvisWidgetCompactProvider : JarvisWidgetProvider()  // ~3×2  (short cards)

class JarvisWidgetTallProvider : JarvisWidgetProvider()     // ~4×5  (lists / tables)

class JarvisWidgetXTallProvider : JarvisWidgetProvider()    // ~4×7  (long terminals)
