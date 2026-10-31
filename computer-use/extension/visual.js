// Graphical (pixel-level) control of a tab — VM consoles (noVNC, Guacamole,
// SPICE, VMware), remote desktops, canvas/video apps. Loaded by sw.js via
// importScripts; shares its globals (attached, ensureAttached, cdp,
// targetTab, checkScriptable).
//
// This file only MEASURES, CAPTURES and DISPATCHES. The engine
// (computer-use/computer_use_mcp/browser_visual.py) does the coordinate math and
// builds the CDP Input.* event lists, so the logic is unit-tested in Python.
//
//   page.inspect   -> screenshot (Page.captureScreenshot, device px), optional
//                     crop/downscale/grid, the measured image->CSS mapping, and
//                     per-frame surface/iframe reports for every frame we reach.
//   page.surfaces  -> just the per-frame reports (no screenshot).
//   input.sequence -> dispatch a validated batch of Input.dispatchMouseEvent /
//                     dispatchKeyEvent / insertText, releasing held input on
//                     failure, optionally re-capturing to verify the effect.
//
// KEEP IN SYNC: computer-use/extension/visual.js must be byte-identical
// (computer-use/tests/test_browser_visual_extension.py enforces it).

const CINDRO_VISUAL_VERSION = 1;
const VISUAL_INPUT_METHODS = new Set([
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
]);
const focusEmulated = new Set();   // tabIds with Emulation.setFocusEmulationEnabled on
const tabLocks = new Map();        // tabId -> promise tail (serializes input per tab)

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) focusEmulated.delete(source.tabId);
});

function visualSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tabLocks.set(tabId, tail);
  tail.then(() => { if (tabLocks.get(tabId) === tail) tabLocks.delete(tabId); });
  return run;
}

// Attach the debugger; a FRESH attach shows Chrome's "being debugged" infobar,
// which shrinks the viewport — give layout a beat so we measure the final size.
async function visualAttach(tabId) {
  const fresh = !attached.has(tabId);
  await ensureAttached(tabId);
  if (fresh) await visualSleep(350);
  return fresh;
}

// Make the page behave as focused even when the Chrome window isn't (the agent
// works while the user is in another app): VM consoles drop keys when
// document.hasFocus() is false.
async function visualFocus(tabId) {
  if (focusEmulated.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulated.add(tabId);
  } catch (e) { /* older Chrome: best-effort */ }
}

// ---------------------------------------------------------------- frame scan

// Runs INSIDE every frame (chrome.scripting, isolated world). Self-contained.
function __cindroFrameReport() {
  const num = (v) => parseFloat(v) || 0;
  const MAX_EL = 6000;
  function* walk(root, depth) {
    let count = 0;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = it.currentNode;
    while (n && count < MAX_EL) {
      if (n.nodeType === 1) {
        yield n;
        if (n.shadowRoot && depth < 4) yield* walk(n.shadowRoot, depth + 1);
      }
      n = it.nextNode();
      count++;
    }
  }
  function box(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || num(cs.opacity) < 0.05) return null;
    const ow = el.offsetWidth || r.width, oh = el.offsetHeight || r.height;
    const sx = r.width / ow, sy = r.height / oh;
    const bl = num(cs.borderLeftWidth), bt = num(cs.borderTopWidth);
    const br = num(cs.borderRightWidth), bb = num(cs.borderBottomWidth);
    const pl = num(cs.paddingLeft), pt = num(cs.paddingTop);
    const pr = num(cs.paddingRight), pb = num(cs.paddingBottom);
    const lw = Math.max(0, ow - bl - br - pl - pr), lh = Math.max(0, oh - bt - bb - pt - pb);
    return { x: r.left + (bl + pl) * sx, y: r.top + (bt + pt) * sy, w: lw * sx, h: lh * sy, lw, lh, sx, sy, cs };
  }
  function ctxText(el) {
    let s = "";
    let n = el;
    for (let i = 0; n && i < 10; i++) {
      s += " " + (n.id || "") + " " + (typeof n.className === "string" ? n.className : "");
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return (s + " " + location.href + " " + document.title).toLowerCase();
  }
  function classify(el, b) {
    const ctx = ctxText(el);
    const tag = el.tagName.toLowerCase();
    if (/novnc/.test(ctx)) return "novnc";
    if (/guac/.test(ctx)) return "guacamole";
    if (/spice/.test(ctx)) return "spice";
    if (/wmks|vmware|vsphere|\bmks\b|vmrc/.test(ctx)) return "vmware";
    if (/kasm/.test(ctx)) return "kasm";
    if (/xterm|terminal/.test(ctx)) return "terminal";
    if (/\brdp\b|remote.?desktop|bastion|myrtille|devolutions/.test(ctx)) return "rdp";
    if (/\bvnc\b|vnc[_-]|[_-]vnc|\bkvm\b|ipmi|idrac|\bilo\b|pikvm/.test(ctx)) return "vnc";
    if (tag === "video") return (!el.controls && b.w * b.h > 120000) ? "remote-video" : "video";
    if (tag === "img") return "stream-image";
    if (tag === "embed" || tag === "object") return "plugin";
    return "canvas";
  }
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  const TEXTY = /^(text|search|email|url|password|number|tel|)$/;
  function describeActive(a) {
    if (!a || a === document.body || a === document.documentElement) return a ? { tag: a.tagName } : null;
    const tag = a.tagName;
    const editable = (tag === "INPUT" && TEXTY.test((a.type || "").toLowerCase())) ||
                     tag === "TEXTAREA" || !!a.isContentEditable;
    let plainText = false;
    if (editable) {
      const r = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      const hint = ((a.id || "") + " " + (typeof a.className === "string" ? a.className : "")).toLowerCase();
      plainText = r.width >= 4 && r.height >= 4 && num(cs.opacity) >= 0.05 &&
                  !/xterm|guac|novnc|vnc|keyboard|clipboard|terminal|helper/.test(hint);
    }
    return { tag, id: a.id || "", editable, plainText };
  }

  const out = {
    href: location.href, title: document.title,
    innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
    scrollX: scrollX, scrollY: scrollY,
    fullscreen: !!document.fullscreenElement, hasFocus: document.hasFocus(),
    visualViewport: window.visualViewport ? {
      x: visualViewport.offsetLeft, y: visualViewport.offsetTop,
      w: visualViewport.width, h: visualViewport.height, scale: visualViewport.scale,
    } : null,
    iframes: [], surfaces: [], active: null,
  };
  const active = deepActive();
  out.active = describeActive(active);
  for (const el of walk(document.documentElement || document, 0)) {
    const tag = el.tagName;
    if (tag === "IFRAME" || tag === "FRAME") {
      const b = box(el);
      if (!b) continue;
      out.iframes.push({
        src: el.srcdoc ? "about:srcdoc" : (el.src || "about:blank"), name: el.name || "",
        x: b.x, y: b.y, w: b.lw, h: b.lh, sx: b.sx, sy: b.sy,
      });
    } else if (tag === "CANVAS" || tag === "VIDEO" || tag === "EMBED" || tag === "OBJECT" || tag === "IMG") {
      const b = box(el);
      if (!b || b.w < 48 || b.h < 48) continue;
      if (tag === "IMG") {
        const hint = ((el.id || "") + " " + (el.className || "") + " " + (el.src || "")).toLowerCase();
        if (b.w * b.h < 40000 || !/stream|screen|kvm|vnc|display|desktop|^blob:|mjpe?g/.test(hint)) continue;
      }
      let iw = 0, ih = 0;
      if (tag === "CANVAS") { iw = el.width; ih = el.height; }
      else if (tag === "VIDEO") { iw = el.videoWidth; ih = el.videoHeight; }
      else if (tag === "IMG") { iw = el.naturalWidth; ih = el.naturalHeight; }
      out.surfaces.push({
        tag: tag.toLowerCase(), kind: classify(el, b),
        label: el.getAttribute("aria-label") || el.title || el.id || "",
        box: { x: b.x, y: b.y, w: b.w, h: b.h },
        intrinsic: iw && ih ? { w: iw, h: ih } : null,
        fit: tag === "EMBED" || tag === "OBJECT" ? "fill" : (b.cs.objectFit || "fill"),
        position: b.cs.objectPosition || "50% 50%",
        focused: el === active,
      });
      if (out.surfaces.length >= 24) break;
    }
  }
  return out;
}

async function visualFrames(tabId) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: __cindroFrameReport,
    });
  } catch (e) {
    // A frame we can't script (sandboxed/about:) can fail the batch — fall back
    // to the main frame alone rather than losing the whole inspection.
    results = await chrome.scripting.executeScript({ target: { tabId }, func: __cindroFrameReport });
  }
  return (results || [])
    .filter((r) => r && r.result)
    .map((r) => Object.assign({ frameId: r.frameId }, r.result));
}

// ---------------------------------------------------------------- imaging

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function setTakeoverOverlay(tabId, visible) {
  // The glow cursor/chip must not end up in what the model reads.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (v) => {
        const el = document.getElementById("__jarvis_takeover");
        if (el) el.style.visibility = v ? "" : "hidden";
      },
      args: [visible],
    });
  } catch (e) { /* not scriptable / no overlay */ }
}

async function captureBitmap(tabId) {
  await setTakeoverOverlay(tabId, false);
  let res;
  let timer = 0;
  try {
    // A background tab in a visible Chrome may never paint a frame; fail fast
    // with something actionable instead of hanging until the bridge timeout.
    res = await Promise.race([
      chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(
        "Chrome produced no frame for this tab (is it in the background or minimized?) — " +
        "bring it forward with browser_tab_activate and inspect again")), 12000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await setTakeoverOverlay(tabId, true);
  }
  return await createImageBitmap(b64ToBlob(res.data, "image/png"));
}

function drawGrid(g, w, h, step) {
  g.save();
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255,0,170,0.45)";
  g.fillStyle = "rgba(255,0,170,0.9)";
  g.font = "10px sans-serif";
  for (let x = step; x < w; x += step) {
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke();
    g.fillText(String(x), x + 2, 10);
  }
  for (let y = step; y < h; y += step) {
    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
    g.fillText(String(y), 2, y - 2);
  }
  g.restore();
}

async function renderImage(bmp, src, outW, outH, opts) {
  const c = new OffscreenCanvas(outW, outH);
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, src.x, src.y, src.w, src.h, 0, 0, outW, outH);
  if (opts.grid) drawGrid(g, outW, outH, opts.gridStep || 100);
  const jpeg = opts.format === "jpeg";
  const blob = await c.convertToBlob(jpeg ? { type: "image/jpeg", quality: 0.85 } : { type: "image/png" });
  return `data:${jpeg ? "image/jpeg" : "image/png"};base64,${await blobToB64(blob)}`;
}

// Tiny grayscale fingerprint for before/after change detection.
function thumbnail(bmp, src) {
  const w = 96, h = Math.max(1, Math.round(96 * src.h / Math.max(1, src.w)));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, src.x, src.y, src.w, src.h, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
  return out;
}

function changeRatio(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) changed++;
  return changed / a.length;
}

// One capture -> image + mapping. `p`: {clip:{x,y,w,h} css, maxWidth, maxHeight,
// grid, gridStep, format, upscale, noImage}
async function captureView(tab, p, frames) {
  const main = frames.find((f) => f.frameId === 0) || frames[0];
  let cssW, cssH;
  if (main) { cssW = main.innerW; cssH = main.innerH; }
  const bmp = await captureBitmap(tab.id);
  if (!cssW || !cssH) {
    const lm = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.getLayoutMetrics");
    const vv = lm.cssVisualViewport || lm.visualViewport;
    cssW = vv.clientWidth; cssH = vv.clientHeight;
  }
  const s0x = bmp.width / cssW, s0y = bmp.height / cssH;
  let clip = { x: 0, y: 0, w: cssW, h: cssH };
  if (p.clip) {
    const x0 = Math.max(0, p.clip.x), y0 = Math.max(0, p.clip.y);
    const x1 = Math.min(cssW, p.clip.x + p.clip.w), y1 = Math.min(cssH, p.clip.y + p.clip.h);
    if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error("region is outside the visible viewport");
    clip = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const src = { x: clip.x * s0x, y: clip.y * s0y, w: clip.w * s0x, h: clip.h * s0y };
  const maxW = p.maxWidth || 1280, maxH = p.maxHeight || 1280;
  let k = Math.min(maxW / src.w, maxH / src.h);
  if (!p.upscale) k = Math.min(k, 1);
  else k = Math.min(k, 3);
  const outW = Math.max(1, Math.round(src.w * k)), outH = Math.max(1, Math.round(src.h * k));
  const res = {
    tabId: tab.id,
    imageWidth: outW, imageHeight: outH,
    mapping: { originX: clip.x, originY: clip.y, scaleX: outW / clip.w, scaleY: outH / clip.h },
    viewport: { width: cssW, height: cssH },
    scroll: main ? { x: main.scrollX, y: main.scrollY } : null,
    capture: { width: bmp.width, height: bmp.height },
    devicePixelRatio: main ? main.dpr : null,
    fullscreen: main ? main.fullscreen : null,
    title: tab.title, url: tab.url,
  };
  if (!p.noImage) res.dataUrl = await renderImage(bmp, src, outW, outH, p);
  res._thumb = thumbnail(bmp, src);
  return res;
}

async function visualInspect(p) {
  const tab = await targetTab(p);
  checkScriptable(tab);
  await visualAttach(tab.id);
  let frames = await visualFrames(tab.id);
  let res = await captureView(tab, p, frames);
  // Resize race (console toggled fullscreen, infobar appeared): re-measure once.
  const again = await visualFrames(tab.id);
  const m0 = frames.find((f) => f.frameId === 0), m1 = again.find((f) => f.frameId === 0);
  if (m0 && m1 && (m0.innerW !== m1.innerW || m0.innerH !== m1.innerH)) {
    frames = again;
    res = await captureView(tab, p, frames);
  }
  delete res._thumb;
  try { res.zoom = await chrome.tabs.getZoom(tab.id); } catch (e) { res.zoom = null; }
  res.frames = frames;
  res.visualVersion = CINDRO_VISUAL_VERSION;
  return res;
}

async function visualSurfaces(p) {
  const tab = await targetTab(p);
  checkScriptable(tab);
  const frames = await visualFrames(tab.id);
  const main = frames.find((f) => f.frameId === 0) || frames[0] || {};
  return { tabId: tab.id, viewport: { width: main.innerW, height: main.innerH }, frames };
}

async function viewportOf(tabId) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, func: () => [innerWidth, innerHeight, scrollX, scrollY],
  });
  return { width: r.result[0], height: r.result[1], scrollX: r.result[2], scrollY: r.result[3] };
}

// ---------------------------------------------------------------- input

async function visualInput(p) {
  const tab = await targetTab(p);
  checkScriptable(tab);
  const events = Array.isArray(p.events) ? p.events : [];
  for (const ev of events) {
    if (!ev || !VISUAL_INPUT_METHODS.has(ev.method)) {
      throw new Error(`input.sequence only dispatches Input.* events (got ${ev && ev.method})`);
    }
  }
  return await withTabLock(tab.id, async () => {
    await visualAttach(tab.id);
    if (p.focus !== false) await visualFocus(tab.id);
    const vp = await viewportOf(tab.id);
    const exp = p.expectViewport;
    if (exp && (Math.abs(vp.width - exp.width) > 1 || Math.abs(vp.height - exp.height) > 1)) {
      throw new Error(`viewport changed since the inspection (${exp.width}x${exp.height} -> ` +
        `${vp.width}x${vp.height}; console resized/fullscreen?) — call browser_visual_inspect again`);
    }
    if (exp && exp.scrollX != null &&
        (Math.abs(vp.scrollX - exp.scrollX) > 1 || Math.abs(vp.scrollY - exp.scrollY) > 1)) {
      throw new Error(`page scrolled since the inspection (${exp.scrollX},${exp.scrollY} -> ` +
        `${vp.scrollX},${vp.scrollY}) — call browser_visual_inspect again`);
    }
    let before = null;
    if (p.verify) {
      const frames = await visualFrames(tab.id);
      before = await captureView(tab, Object.assign({}, p.verify, { noImage: true }), frames);
    }
    if (p.pointer && typeof p.pointer.x === "number") {
      // Move the in-page glow cursor (extension/content.js) to where we act.
      chrome.tabs.sendMessage(tab.id, { type: "pointAt", x: p.pointer.x, y: p.pointer.y },
        { frameId: 0 }).catch(() => {});
    }
    let n = 0;
    try {
      for (const ev of events) {
        const d = Math.min(Math.max(Number(ev.delayMs) || 0, 0), 10000);
        if (d) await visualSleep(d);
        await chrome.debugger.sendCommand({ tabId: tab.id }, ev.method, ev.params || {});
        n++;
      }
    } catch (e) {
      for (const rel of (p.releaseOnError || [])) {
        try { await chrome.debugger.sendCommand({ tabId: tab.id }, rel.method, rel.params || {}); } catch (_) {}
      }
      throw new Error(`input failed after ${n}/${events.length} events: ${e && e.message || e} ` +
        "(held buttons/keys were released)");
    }
    const out = { tabId: tab.id, dispatched: n, viewport: vp };
    if (p.verify) {
      await visualSleep(Math.min(Math.max(Number(p.verify.settleMs) || 0, 0), 10000));
      const frames = await visualFrames(tab.id);
      const after = await captureView(tab, p.verify, frames);
      after.changeRatio = changeRatio(before._thumb, after._thumb);
      delete after._thumb;
      after.frames = frames;
      try { after.zoom = await chrome.tabs.getZoom(tab.id); } catch (e) { after.zoom = null; }
      out.verify = after;
    }
    return out;
  });
}

async function visualFocusInfo(p) {
  const tab = await targetTab(p);
  checkScriptable(tab);
  const frames = await visualFrames(tab.id);
  return {
    tabId: tab.id,
    frames: frames.map((f) => ({ frameId: f.frameId, href: f.href, hasFocus: f.hasFocus, active: f.active })),
  };
}

const VISUAL_HANDLERS = {
  "page.inspect": visualInspect,
  "page.surfaces": visualSurfaces,
  "page.focus": visualFocusInfo,
  "input.sequence": visualInput,
};
