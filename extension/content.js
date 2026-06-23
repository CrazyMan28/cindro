// Content script: page snapshot with stable refs + click/type/select/scroll.
// Refs (e1, e2, ...) belong to a snapshot generation; they go stale when a new
// snapshot is taken or the page navigates.

(() => {
  if (window.__cuContentLoaded) return;
  window.__cuContentLoaded = true;

  // ===================================================================
  // Take-over cursor (per docs/TAKEOVER_UX.md) — a glowing cyan agent
  // pointer + a "Jarvis is using this tab" chip, shown ONLY while the
  // agent is driving this tab. Self-contained: every agent action the
  // content script performs resolves its own target element, so the glow
  // travels (CSS transition) to that element's rect center. No libs.
  // ===================================================================
  const ACCENT = "#29E7FF"; // HUD cyan, matches desktop Theme.accent
  const CHIP_HIDE_MS = 3000; // auto-hide the chip after this much inactivity

  const Takeover = (() => {
    let root = null;       // fixed container hosting cursor + chip
    let cursor = null;     // glow halo + arrow that travels to each action
    let chip = null;       // top-center "Jarvis is using this tab" pill
    let hideTimer = 0;     // chip inactivity auto-hide
    let driving = false;   // true only while the agent is in control
    let injected = false;

    function ensure() {
      if (injected && root && document.documentElement.contains(root)) return;
      injected = true;

      root = document.createElement("div");
      root.id = "__jarvis_takeover";
      root.setAttribute("aria-hidden", "true");
      Object.assign(root.style, {
        position: "fixed", inset: "0", zIndex: "2147483647",
        pointerEvents: "none", margin: "0", padding: "0", border: "0",
        contain: "layout style size",
      });

      // --- glowing cursor: radial halo + a small Jarvis arrow ----------
      cursor = document.createElement("div");
      Object.assign(cursor.style, {
        position: "fixed", left: "0", top: "0", width: "44px", height: "44px",
        // hotspot (arrow tip) at the action point -> offset the box so its
        // top-left arrow tip lands on (left,top) we set via transform.
        transform: "translate(-9px, -6px)",
        pointerEvents: "none", opacity: "0", willChange: "transform, opacity",
        transition: "transform 380ms cubic-bezier(.22,.61,.36,1), opacity 200ms ease",
      });

      // soft cyan radial glow halo (~40px, blurred)
      const halo = document.createElement("div");
      Object.assign(halo.style, {
        position: "absolute", left: "50%", top: "50%", width: "44px", height: "44px",
        marginLeft: "-22px", marginTop: "-22px", borderRadius: "50%",
        background: `radial-gradient(circle, ${ACCENT}cc 0%, ${ACCENT}66 38%, ${ACCENT}00 70%)`,
        filter: "blur(3px)",
        boxShadow: `0 0 18px 4px ${ACCENT}aa, 0 0 36px 10px ${ACCENT}55`,
        animation: "__jarvisPulse 1400ms ease-in-out infinite",
      });
      cursor.appendChild(halo);

      // distinct Jarvis arrow sprite (SVG), clearly not the OS cursor
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("width", "22");
      arrow.setAttribute("height", "26");
      Object.assign(arrow.style, {
        position: "absolute", left: "9px", top: "6px",
        filter: `drop-shadow(0 0 4px ${ACCENT})`,
      });
      arrow.innerHTML =
        `<path d="M2 1 L2 21 L7.5 16 L11 24 L15 22 L11.5 14.5 L19 14 Z" ` +
        `fill="${ACCENT}" stroke="#0A0E16" stroke-width="1.1" stroke-linejoin="round"/>`;
      cursor.appendChild(arrow);
      root.appendChild(cursor);

      // --- top-center "Jarvis is using this tab" chip ------------------
      chip = document.createElement("div");
      Object.assign(chip.style, {
        position: "fixed", top: "14px", left: "50%", transform: "translate(-50%, -8px)",
        display: "flex", alignItems: "center", gap: "8px",
        padding: "7px 14px", borderRadius: "999px",
        background: "rgba(10,14,22,0.92)", color: "#EAF6FF",
        font: "600 13px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        letterSpacing: "0.2px", whiteSpace: "nowrap",
        border: `1px solid ${ACCENT}`,
        boxShadow: `0 0 14px ${ACCENT}88, 0 4px 18px rgba(0,0,0,0.45)`,
        pointerEvents: "none", opacity: "0", willChange: "transform, opacity",
        transition: "opacity 240ms ease, transform 240ms ease",
      });
      chip.innerHTML =
        `<span style="font-size:14px;line-height:1">⚡</span>` +
        `<span>Jarvis is using this tab</span>`;
      root.appendChild(chip);

      // keyframes for the halo pulse (scoped style node)
      if (!document.getElementById("__jarvis_takeover_kf")) {
        const st = document.createElement("style");
        st.id = "__jarvis_takeover_kf";
        st.textContent =
          "@keyframes __jarvisPulse{0%,100%{opacity:.55;transform:scale(.9)}" +
          "50%{opacity:1;transform:scale(1.12)}}";
        (document.head || document.documentElement).appendChild(st);
      }

      (document.body || document.documentElement).appendChild(root);
    }

    function showChip() {
      ensure();
      chip.style.opacity = "1";
      chip.style.transform = "translate(-50%, 0)";
      if (hideTimer) clearTimeout(hideTimer);
      // Only auto-hide while driving stays true; if driving is turned off we
      // hide immediately via setDriving(false).
      hideTimer = setTimeout(() => { if (chip) chip.style.opacity = "0"; }, CHIP_HIDE_MS);
    }

    // Move the glow cursor to a viewport point (px from getBoundingClientRect).
    function moveToPoint(x, y) {
      ensure();
      cursor.style.opacity = "1";
      cursor.style.transform = `translate(${x - 9}px, ${y - 6}px)`;
    }

    // Move the glow cursor to the center of an element's bounding rect.
    function moveToElement(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") return;
      const r = el.getBoundingClientRect();
      moveToPoint(r.left + r.width / 2, r.top + r.height / 2);
    }

    // Called on every agent action so the take-over UI is unmistakable and
    // the glow visibly travels to what the agent is doing.
    function onAction(el, point) {
      setDriving(true);
      if (el) moveToElement(el);
      else if (point && typeof point.x === "number") moveToPoint(point.x, point.y);
      showChip();
    }

    function setDriving(on) {
      ensure();
      driving = !!on;
      if (driving) {
        showChip();
      } else {
        // hand control back: hide chip + cursor immediately.
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
        chip.style.opacity = "0";
        cursor.style.opacity = "0";
      }
    }

    return { onAction, moveToElement, moveToPoint, setDriving, showChip,
             isDriving: () => driving };
  })();

  // Expose so sw.js (via chrome.scripting MAIN-world is not used here) and the
  // message handler below can drive it; also handy for manual debugging.
  window.__jarvisTakeover = Takeover;

  let gen = 0;
  let refs = new Map(); // "e3" -> WeakRef<Element>

  const INTERACTIVE = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
    "[role=radio]", "[role=menuitem]", "[role=combobox]", "[role=switch]",
    "[role=option]", "[role=searchbox]", "[role=textbox]",
    "[onclick]", "[contenteditable=true]", "[contenteditable='']",
  ].join(",");

  function isRendered(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function labelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    const ph = el.getAttribute("placeholder");
    if (ph) return ph;
    const title = el.getAttribute("title");
    if (title) return title;
    let text = (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
    if (!text && el.tagName === "INPUT") text = el.name || "";
    return text.slice(0, 80);
  }

  function roleFor(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return `input:${(el.type || "text").toLowerCase()}`;
    if (tag === "a") return "link";
    if (el.isContentEditable) return "editable";
    return tag;
  }

  function snapshot(maxNodes) {
    gen += 1;
    refs = new Map();
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(isRendered);
    const lines = [];
    let truncated = false;
    for (let i = 0; i < els.length; i++) {
      if (lines.length >= maxNodes) { truncated = true; break; }
      const el = els[i];
      const ref = `e${i + 1}`;
      refs.set(ref, new WeakRef(el));
      const rect = el.getBoundingClientRect();
      const bits = [`${ref} [${roleFor(el)}]`];
      const label = labelFor(el);
      if (label) bits.push(JSON.stringify(label));
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        if (el.type === "checkbox" || el.type === "radio") bits.push(`checked=${el.checked}`);
        else if (el.value) bits.push(`value=${JSON.stringify(String(el.value).slice(0, 40))}`);
      }
      if (el.tagName === "SELECT") {
        const sel = el.selectedOptions[0];
        bits.push(`selected=${JSON.stringify(sel ? sel.textContent.trim().slice(0, 40) : "")}`);
        bits.push(`options=${el.options.length}`);
      }
      if (el.disabled) bits.push("(disabled)");
      if (el.tagName === "A") {
        const href = el.getAttribute("href");
        if (href && href !== "#") bits.push(`href=${href.slice(0, 80)}`);
      }
      const inView = rect.bottom > 0 && rect.top < innerHeight;
      if (!inView) bits.push(rect.top >= innerHeight ? "(below fold)" : "(above fold)");
      lines.push("  " + bits.join(" "));
    }
    const doc = document.documentElement;
    const header = [
      `PAGE: ${document.title}`,
      `URL: ${location.href}`,
      `VIEWPORT: ${innerWidth}x${innerHeight} scrollY=${Math.round(scrollY)}/${Math.max(0, doc.scrollHeight - innerHeight)}`,
      `INTERACTIVE (${lines.length}${truncated ? `, truncated of ${els.length}` : ""}):`,
    ];
    // A little visible page text helps the agent orient without a screenshot.
    const bodyText = (document.body ? document.body.innerText : "")
      .replace(/\s+/g, " ").trim().slice(0, 1500);
    return {
      gen,
      text: header.join("\n") + "\n" + lines.join("\n") +
            (bodyText ? `\nTEXT: ${bodyText}` : ""),
    };
  }

  function resolve(ref, selector) {
    if (ref) {
      const wr = refs.get(ref);
      const el = wr && wr.deref();
      if (!el || !el.isConnected) {
        throw new Error(`ref ${ref} is stale (page changed?) — call browser_snapshot again`);
      }
      return el;
    }
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches selector ${selector}`);
      return el;
    }
    throw new Error("need ref or selector");
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    if (el.form && typeof el.form.requestSubmit === "function") {
      // If the page handled Enter itself this is a no-op risk; most search
      // boxes either submit a form or listen for keydown — try the form last.
      try { el.form.requestSubmit(); } catch (e) {}
    }
  }

  const ACTIONS = {
    snapshot: (p) => snapshot(p.maxNodes || 600),

    clickPoint: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      Takeover.onAction(el);
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    click: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      Takeover.onAction(el);
      if (typeof el.focus === "function") el.focus();
      el.click();
      return { clicked: true, label: labelFor(el).slice(0, 60) };
    },

    type: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      Takeover.onAction(el);
      if (typeof el.focus === "function") el.focus();
      if (el.isContentEditable) {
        if (p.clear) {
          const sel = getSelection();
          sel.selectAllChildren(el);
          document.execCommand("delete");
        }
        document.execCommand("insertText", false, p.text);
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        setNativeValue(el, p.clear ? p.text : (el.value || "") + p.text);
      } else {
        throw new Error(`element ${p.ref || p.selector} is not typeable (${el.tagName})`);
      }
      if (p.submit) pressEnter(el);
      return { typed: p.text.length, submitted: !!p.submit };
    },

    select: (p) => {
      const el = resolve(p.ref, p.selector);
      if (el.tagName !== "SELECT") throw new Error("element is not a <select>");
      Takeover.onAction(el);
      const want = String(p.value);
      let opt = [...el.options].find((o) => o.value === want)
             || [...el.options].find((o) => o.textContent.trim() === want)
             || [...el.options].find((o) => o.textContent.trim().toLowerCase().includes(want.toLowerCase()));
      if (!opt) throw new Error(`no option matching ${want} (options: ${[...el.options].map((o) => o.textContent.trim()).slice(0, 20).join(" | ")})`);
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: opt.textContent.trim() };
    },

    scroll: (p) => {
      if (p.ref) {
        const el = resolve(p.ref, null);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        Takeover.onAction(el);
      } else {
        const amount = p.amount || 600;
        window.scrollBy(0, p.direction === "up" ? -amount : amount);
        // No target element for a page scroll — glow points at the viewport
        // center (the region the scroll reveals) so the chip stays present.
        Takeover.onAction(null, { x: innerWidth / 2, y: innerHeight / 2 });
      }
      const doc = document.documentElement;
      return { scrollY: Math.round(scrollY), max: Math.max(0, doc.scrollHeight - innerHeight) };
    },

    // Explicit driving on/off signal (e.g. relayed from sw.js when a take-over
    // starts/ends or is cancelled). Lets the chip appear/disappear even when no
    // element-targeted action has arrived yet.
    driving: (p) => {
      Takeover.setDriving(!!(p && p.on));
      return { driving: Takeover.isDriving() };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !ACTIONS[msg.type]) return false;
    try {
      sendResponse(ACTIONS[msg.type](msg));
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
    return false;
  });
})();
