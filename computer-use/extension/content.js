// Content script: page snapshot with stable refs + click/type/select/scroll.
// Refs (e1, e2, ...) belong to a snapshot generation; they go stale when a new
// snapshot is taken or the page navigates.

(() => {
  if (window.__cuContentLoaded) return;
  window.__cuContentLoaded = true;

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

  // ---- Jarvis "using this tab" overlay: a glowing cyan cursor + chip drawn IN
  //  the page, so when the agent drives Chrome you SEE where it's acting (mirrors
  //  the desktop take-over overlay). Pure visual, pointer-events:none — never
  //  interferes with the page or the agent's own clicks. Auto-hides when idle.
  const jarvisGlow = (() => {
    let root, chip, cursor, ring, hideTimer;
    function ensure() {
      if (root && document.documentElement.contains(root)) return;
      root = document.createElement("div");
      root.id = "__jarvis_glow_root";
      root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
      const st = document.createElement("style");
      st.textContent =
        "@keyframes __jvpulse{0%{transform:scale(.8);opacity:.35}50%{transform:scale(1.2);opacity:.6}100%{transform:scale(.8);opacity:.35}}"
        + "@keyframes __jvripple{0%{transform:scale(.5);opacity:.9}100%{transform:scale(3.6);opacity:0}}"
        + "#__jv_chip{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:rgba(10,14,22,.92);"
        + "border:1px solid #19E3D6;color:#DCF8F6;font:600 13px/1 system-ui,sans-serif;padding:9px 16px;border-radius:999px;"
        + "box-shadow:0 0 18px rgba(25,227,214,.5);display:flex;gap:8px;align-items:center;opacity:0;transition:opacity .2s}"
        + "#__jv_cur{position:fixed;left:0;top:0;width:64px;height:64px;transition:transform .11s cubic-bezier(.22,.61,.36,1)}"
        + "#__jv_halo{position:absolute;left:14px;top:14px;width:36px;height:36px;border-radius:50%;background:#19E3D6;filter:blur(8px);opacity:.45;animation:__jvpulse 1.8s infinite}"
        + "#__jv_ring{position:absolute;left:20px;top:20px;width:24px;height:24px;border-radius:50%;border:2px solid #7CFCEF;opacity:0}";
      root.appendChild(st);
      chip = document.createElement("div");
      chip.id = "__jv_chip";
      chip.innerHTML = '<span style="color:#7CFCEF">⚡</span><span>Jarvis is using this tab</span>';
      cursor = document.createElement("div");
      cursor.id = "__jv_cur";
      cursor.innerHTML =
        '<div id="__jv_halo"></div>'
        + '<svg width="26" height="30" viewBox="0 0 26 30" style="position:absolute;left:24px;top:22px">'
        + '<path d="M0 0 L0 20 L5.5 15 L9 23 L13 21 L9.5 13.5 L17 13 Z" fill="#19E3D6" stroke="#7CFCEF" stroke-width="1.4" stroke-linejoin="round"/></svg>'
        + '<div id="__jv_ring"></div>';
      root.appendChild(chip);
      root.appendChild(cursor);
      (document.documentElement || document.body).appendChild(root);
      ring = cursor.querySelector("#__jv_ring");
    }
    function show() {
      ensure();
      chip.style.opacity = "1";
      cursor.style.opacity = "1";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (chip) chip.style.opacity = "0";
        if (cursor) cursor.style.opacity = "0";
      }, 8000);
    }
    function at(x, y, action) {
      show();
      // place the arrow tip (~ +24,+22 within the 64px cursor) at (x,y)
      cursor.style.transform = "translate(" + (x - 24) + "px," + (y - 22) + "px)";
      if (action === "click" || action === "type") {
        ring.style.animation = "none";
        void ring.offsetWidth;            // reflow so the ripple restarts
        ring.style.animation = "__jvripple .45s ease-out";
      }
    }
    function elAt(el, action) {
      try {
        const r = el.getBoundingClientRect();
        at(r.left + r.width / 2, r.top + r.height / 2, action);
      } catch (e) { /* non-fatal */ }
    }
    return { at, elAt, show };
  })();

  const ACTIONS = {
    snapshot: (p) => snapshot(p.maxNodes || 600),

    clickPoint: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      jarvisGlow.at(r.left + r.width / 2, r.top + r.height / 2, "click");
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    click: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      jarvisGlow.elAt(el, "click");
      if (typeof el.focus === "function") el.focus();
      el.click();
      return { clicked: true, label: labelFor(el).slice(0, 60) };
    },

    type: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      jarvisGlow.elAt(el, "type");
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
      } else {
        const amount = p.amount || 600;
        window.scrollBy(0, p.direction === "up" ? -amount : amount);
      }
      const doc = document.documentElement;
      return { scrollY: Math.round(scrollY), max: Math.max(0, doc.scrollHeight - innerHeight) };
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
