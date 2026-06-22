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

  const ACTIONS = {
    snapshot: (p) => snapshot(p.maxNodes || 600),

    clickPoint: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    click: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      if (typeof el.focus === "function") el.focus();
      el.click();
      return { clicked: true, label: labelFor(el).slice(0, 60) };
    },

    type: (p) => {
      const el = resolve(p.ref, p.selector);
      el.scrollIntoView({ block: "center", behavior: "instant" });
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
