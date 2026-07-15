import { render } from "solid-js/web"
import "../core/theme.css" // the shared Cindro (Iron-Man × cyberpunk) token set
import "./styles.css" // page (px-*) + operator-chat and shell (cx-*) styling — widgets/widgets.css is pulled in by WidgetRenderer.tsx
import { App } from "./App"

const root = document.getElementById("root")
if (root) render(() => <App />, root)
