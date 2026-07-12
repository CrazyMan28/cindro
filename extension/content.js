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
  const ACCENT = "#3D8BFF"; // Jarvis azure-blue — matches the desktop driving cursor
  const CHIP_HIDE_MS = 3000; // auto-hide the chip after this much inactivity

  const Takeover = (() => {
    let root = null;       // fixed container hosting cursor + chip
    let cursor = null;     // glow halo + arrow that travels to each action
    let chip = null;       // top-center "Jarvis is using this tab" pill
    let hideTimer = 0;     // chip inactivity auto-hide
    let driving = false;   // true only while the agent is in control
    let drivingLatched = false; // true for the whole turn (side panel signal) —
                                // suppresses the per-action 3s auto-hide
    let lastPoint = null;  // last cursor viewport point, so latched-on keeps it put
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
        `<span>Cindro is controlling Chrome</span>`;
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
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      // While a turn is latched on (side panel said driving=true) the chip must
      // STAY for the whole turn — do NOT schedule the 3s auto-hide. Only when a
      // discrete action shows the chip outside a latched turn do we auto-hide.
      if (!drivingLatched) {
        hideTimer = setTimeout(() => { if (chip) chip.style.opacity = "0"; }, CHIP_HIDE_MS);
      }
    }

    // Move the glow cursor to a viewport point (px from getBoundingClientRect).
    function moveToPoint(x, y) {
      ensure();
      lastPoint = { x, y };
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

    // Turn-level latch from the side panel (panel -> sw -> content). When ON the
    // chip + blue cursor STAY for the whole turn (no 3s auto-hide); per-action
    // moves still travel the cursor. When OFF we fade chip + cursor out.
    function setDrivingLatched(on) {
      ensure();
      drivingLatched = !!on;
      if (drivingLatched) {
        driving = true;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
        // Keep the cursor visible at its last position, or center if we have
        // never placed it this page.
        if (!lastPoint) lastPoint = { x: innerWidth / 2, y: innerHeight / 2 };
        cursor.style.opacity = "1";
        cursor.style.transform = `translate(${lastPoint.x - 9}px, ${lastPoint.y - 6}px)`;
        showChip(); // drivingLatched is true now -> no auto-hide scheduled
      } else {
        // Turn ended (final/error) or user stopped: fade chip + cursor out.
        driving = false;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
        chip.style.opacity = "0";
        cursor.style.opacity = "0";
      }
    }

    return { onAction, moveToElement, moveToPoint, setDriving, setDrivingLatched,
             showChip, isDriving: () => driving };
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
      const ref = `e${gen}.${i + 1}`;
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
      const m = /^e(\d+)\.\d+$/.exec(ref);
      if (!m || Number(m[1]) !== gen) {
        throw new Error(`ref ${ref} is stale (page changed?) — call browser_snapshot again`);
      }
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

    // Re-resolve the same ref/selector right before a trusted CDP click fires
    // (sw.js calls this between clickPoint and Input.dispatchMouseEvent) and
    // confirm the target is STILL the element that will actually receive the
    // click. Two checks: (1) the point is still within the target's current
    // bounds (layout shift), and (2) the topmost element at that point — what a
    // coordinate-based CDP click really hits — is the target, a descendant, or
    // an ancestor of it, NOT some unrelated overlay injected on top after we
    // resolved it (pure containment missed that: an overlay leaves the target's
    // own bounds unchanged). Full atomicity is impossible via CDP (the page's JS
    // isn't paused during the debugger dispatch), so this shrinks the window and
    // aborts on any detectable mismatch rather than delivering a redirected click.
    verifyPoint: (p) => {
      const el = resolve(p.ref, p.selector);
      const r = el.getBoundingClientRect();
      const x = Number(p.x), y = Number(p.y);
      const within = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (!within) {
        throw new Error(`element moved before the click landed (target's bounds no longer contain (${x},${y})) — call browser_snapshot again`);
      }
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        throw new Error(`another element is now on top of the target at (${x},${y}) — call browser_snapshot again`);
      }
      return { ok: true };
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

  // On (re)load — e.g. right after Jarvis navigated this tab — ask the service
  // worker whether a turn is currently driving, and if so re-show the banner +
  // cursor immediately so they don't flicker out across navigations.
  try {
    chrome.runtime.sendMessage({ type: "jarvis-driving-query" }, (r) => {
      if (chrome.runtime.lastError) return; // sw asleep / no receiver — ignore
      if (r && r.on) { try { Takeover.setDrivingLatched(true); } catch (e) {} }
    });
  } catch (e) { /* ignore */ }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Turn-level driving latch relayed from the side panel via sw.js. Keeps the
    // chip + blue cursor up for the WHOLE turn (no 3s flicker), hidden on end.
    if (msg && msg.type === "__jarvis_driving") {
      try { Takeover.setDrivingLatched(!!msg.on); } catch (e) {}
      sendResponse({ ok: true, driving: Takeover.isDriving() });
      return false;
    }
    if (!msg || !ACTIONS[msg.type]) return false;
    try {
      sendResponse(ACTIONS[msg.type](msg));
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
    return false;
  });
})();
