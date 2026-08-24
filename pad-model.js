/* pad-model.js -- the draft, the device, and the difference between them.
 *
 * Two states: DRAFT (what the user is designing; the only thing edits touch)
 * and DEVICE (what the hardware last told us; null until connected, never
 * edited). The write button is enabled exactly when diff() reports a change.
 *
 * Shapes, in the driver's terms (see pad-driver.js):
 *   config = { layers: {1:[binding],2:[...],3:[...]},
 *              leds:   {1:{mode,colors:[hex×16]}, 2:..., 3:...} }
 *   binding = { keyId, kind, codes:[usage], delays:[ms], mouse:{mod,buttons,wheel} }
 *
 * Layers and LEDs are both 1-based here, as everywhere above the driver.
 */

const LAYERS = [1, 2, 3];
const LED_SLOTS = 16;
export const STORE_KEY = 'macropad.draft.v1';
export const EXPORT_KIND = 'macropad-config';
export const EXPORT_VERSION = 1;

/* ------------------------------------------------------------ normalising

   Bindings that mean the same thing to the device can differ as objects: a
   missing `delays` and a `delays` of all zeros produce identical bytes, and
   an absent `mouse` equals one with three zeroes. Both sides go through here
   before anything compares them. */

const KIND_MOUSE = 3;   // catalog.KIND_MOUSE, inlined to keep this leaf-free

/** One binding, reduced to the fields that reach the wire. */
export function canonBinding(b) {
  const keyId = b.keyId !== undefined ? b.keyId : b.key_id;
  const kind = b.kind | 0;
  if (kind === KIND_MOUSE) {
    const m = b.mouse || {};
    return { keyId, kind,
             mouse: { mod: m.mod | 0, buttons: m.buttons | 0, wheel: m.wheel | 0 } };
  }
  const codes = (b.codes || []).map(c => c | 0);
  /* The device stores a delay per code and ignores the rest. */
  const delays = codes.map((_, i) => (b.delays && b.delays[i]) | 0);
  return { keyId, kind, codes, delays };
}

/** A layer as a keyId -> binding map, with NULL bindings dropped.
 *  A key bound to nothing and a key absent from the list are the same pad. */
export function canonLayer(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const c = canonBinding(r);
    if (isNull(c)) continue;
    out.set(c.keyId, c);
  }
  return out;
}

/** Nothing bound. The device reports these as real rows and the draft omits
 *  them, so both must normalise to the same thing. */
export function isNull(c) {
  if (c.kind === KIND_MOUSE) {
    const m = c.mouse;
    return !m.mod && !m.buttons && !m.wheel;
  }
  return !c.codes.length || c.codes.every(x => x === 0);
}

/** LED state for one layer, padded to the device's 16 slots. */
export function canonLeds(led) {
  if (!led) return null;
  const colors = [];
  for (let i = 0; i < LED_SLOTS; i++) colors.push(hex(led.colors && led.colors[i]));
  return { mode: led.mode | 0, colors };
}

function hex(c) {
  if (typeof c === 'string') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(c);
    return m ? '#' + m[1].toLowerCase() : '#000000';
  }
  if (Array.isArray(c)) {
    return '#' + c.slice(0, 3).map(v => (v | 0).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

/** A whole config, both halves normalised. */
export function canonConfig(cfg) {
  const layers = {}, leds = {};
  for (const L of LAYERS) {
    layers[L] = canonLayer(cfg && cfg.layers && cfg.layers[L]);
    const src = cfg && cfg.leds;
    const raw = Array.isArray(src) ? src[L - 1] : (src && src[L]);
    leds[L] = canonLeds(raw);
  }
  return { layers, leds };
}

/* ------------------------------------------------------------------ diff */

/** What would have to be written to make `device` match `draft`.
 *  Returns { bindings:[{layer,binding}], leds:[layer], count }.
 *  With `device` null everything in the draft counts as pending. */
export function diff(draft, device) {
  const a = canonConfig(draft);
  const b = device ? canonConfig(device) : null;
  const bindings = [], leds = [];

  for (const L of LAYERS) {
    const want = a.layers[L];
    const have = b ? b.layers[L] : new Map();
    /* Every key mentioned on either side: a key cleared in the draft still
       needs a write, because the device is holding the old binding. */
    const keys = new Set([...want.keys(), ...have.keys()]);
    for (const k of [...keys].sort((x, y) => x - y)) {
      const w = want.get(k), h = have.get(k);
      if (same(w, h)) continue;
      /* Cleared in the draft: write an explicit NULL rather than skipping,
         or the device keeps what the user just deleted. */
      bindings.push({ layer: L, keyId: k, binding: w || nullBinding(k, h) });
    }
    /* With no device, any LED the draft has is pending. With a device, an
       absent record on either side means "no opinion" -- see sameLeds. */
    if (b ? !sameLeds(a.leds[L], b.leds[L]) : !!a.leds[L]) leds.push(L);
  }
  return { bindings, leds, count: bindings.length + leds.length };
}

/** A binding that unbinds. Matching the old kind keeps a mouse key from
 *  being cleared with a keyboard packet, which the device reads differently. */
function nullBinding(keyId, old) {
  const kind = old ? old.kind : 0;
  if (kind === KIND_MOUSE) {
    return { keyId, kind, codes: [], delays: [], mouse: { mod: 0, buttons: 0, wheel: 0 } };
  }
  return { keyId, kind, codes: [], delays: [] };
}

function same(x, y) {
  if (!x && !y) return true;
  if (!x || !y) return false;
  return JSON.stringify(x) === JSON.stringify(y);
}

/** LEDs compare only over the 12 key slots the UI can colour. The pad reports
 *  16; the four knob slots are never written from here, so a nonzero value in
 *  one of them must not register as a pending change forever.
 *
 *  A missing side is not a difference: a draft with no colour picked has no
 *  LED record while the pad always reports one. Absent means "no opinion". */
function sameLeds(x, y) {
  if (!x || !y) return true;
  if (x.mode !== y.mode) return false;
  for (let i = 0; i < 12; i++) if (x.colors[i] !== y.colors[i]) return false;
  return true;
}

/* --------------------------------------------------------------- persist */

/** The draft, as it goes into localStorage. Maps do not survive JSON, so
 *  layers go back to arrays -- the same shape a fresh read produces. */
export function toPlain(cfg) {
  const c = canonConfig(cfg);
  const layers = {}, leds = {};
  for (const L of LAYERS) {
    layers[L] = [...c.layers[L].values()];
    leds[L] = c.leds[L];
  }
  return { layers, leds };
}

/** Read a draft back, tolerating anything: a corrupt draft must not stop the
 *  page from loading. */
export function fromPlain(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const src = obj.config && typeof obj.config === 'object' ? obj.config : obj;
  if (!src.layers || typeof src.layers !== 'object') return null;
  try { return toPlain(src); } catch { return null; }
}

/** Save the draft. Storage can be full or switched off, so the caller gets a
 *  boolean rather than a throw. */
export function saveDraft(cfg, store) {
  const s = store || globalStorage();
  if (!s) return false;
  try { s.setItem(STORE_KEY, JSON.stringify(toPlain(cfg))); return true; }
  catch { return false; }
}

export function loadDraft(store) {
  const s = store || globalStorage();
  if (!s) return null;
  try { return fromPlain(JSON.parse(s.getItem(STORE_KEY) || 'null')); }
  catch { return null; }
}

export function clearDraft(store) {
  const s = store || globalStorage();
  if (!s) return;
  try { s.removeItem(STORE_KEY); } catch { /* nothing to do about it */ }
}

function globalStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }   // storage disabled by policy throws on access
}

/* ---------------------------------------------------------------- export */

/** The file the user downloads. Stamped so import can recognise it.
 *  `source` records whether this was the app's design or the pad's contents. */
export function toExport(cfg, source, meta = {}) {
  return { kind: EXPORT_KIND, version: EXPORT_VERSION, source,
           exported: meta.at || null, device: meta.device || null,
           config: toPlain(cfg) };
}

/** The config inside an export file. Returns { ok, config, why } -- `why` is
 *  shown to the user. */
export function fromExport(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, why: 'ファイルの中身が読めませんでした' };
  }
  if (obj.kind && obj.kind !== EXPORT_KIND) {
    return { ok: false, why: 'このアプリのエクスポートファイルではありません' };
  }
  if (obj.version && obj.version > EXPORT_VERSION) {
    return { ok: false, why: '新しい形式のファイルです。アプリを更新してください' };
  }
  const cfg = fromPlain(obj);
  if (!cfg) return { ok: false, why: '設定データが見つかりませんでした' };
  return { ok: true, config: cfg };
}

/* ------------------------------------------------------------- utilities */

/** An empty pad: three layers of nothing, no LED state. */
export function emptyConfig() {
  const layers = {}, leds = {};
  for (const L of LAYERS) { layers[L] = []; leds[L] = null; }
  return { layers, leds };
}

/** A deep copy, so the draft and the device snapshot never share objects.
 *  Sharing makes an edit to the draft mutate the "device" side, and diff()
 *  then reports no change. */
export function cloneConfig(cfg) {
  return toPlain(cfg);
}

/** The bindings of one layer as a plain array, for the UI to render. */
export function layerRows(cfg, layer) {
  const rows = cfg && cfg.layers && cfg.layers[layer];
  return Array.isArray(rows) ? rows : [...canonLayer(rows).values()];
}

/** Put one binding into a config, replacing whatever was on that key.
 *  Returns a new config, so an undo stack of past configs stays valid. */
export function withBinding(cfg, binding) {
  const next = toPlain(cfg);
  const L = binding.layer;
  const rows = (next.layers[L] || []).filter(r => r.keyId !== binding.keyId);
  const c = canonBinding(binding);
  if (!isNull(c)) rows.push(c);
  next.layers[L] = rows.sort((a, b) => a.keyId - b.keyId);
  return next;
}

/** Put LED state into a config for one layer. */
export function withLeds(cfg, layer, mode, colors) {
  const next = toPlain(cfg);
  next.leds[layer] = canonLeds({ mode, colors });
  return next;
}
