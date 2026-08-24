/* pad-driver.js -- the seam between the UI and the device.
 *
 * Implementations: PadWebHid (real device), PadMock (tests), PadHttp (legacy).
 *
 * Interface rules:
 *   - key ids are numbers, never "key01".
 *   - layers are 1-based everywhere; LED commands are 0-based on the wire and
 *     each driver converts internally.
 *   - writeBinding is atomic: writes, commits, waits out the settle time.
 *
 * A binding crossing this seam:
 *   { keyId, layer, kind, codes:[usage], delays:[ms], mouse:{mod,buttons,wheel} }
 * codes carries modifiers inline as 0xF1..0xF8, in wire order -- a modifier
 * costs a slot like any key.
 */

import * as W from './pad-wire.js';
import { KIND_MOUSE, MAX_KEY_ID, isPhysical, keyIdToName, MOUSE_BUTTONS }
  from './catalog.js';

/* Measured: at 150ms between writes the later ones are dropped silently and
 * the old value stays. 300ms plus 800ms after the commit was stable. */
export const WRITE_GAP = 300;
export const COMMIT_GAP = 800;
/* The device needs a moment after open() before it answers. */
export const SETTLE_AFTER_OPEN = 250;
/* Measured: a read issued straight after the final commit still answers with
 * the pre-write values. On top of COMMIT_GAP, which is what the device needs
 * to accept the commit -- not to serve the new values on a read. */
export const SETTLE_AFTER_WRITE = 600;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP

/** Posts to an HTTP API that held the device open. Legacy; no server now. */
export class PadHttp {
  constructor(base = '') { this.base = base; this.isMock = false; }

  get name() { return 'http'; }
  isConnected() { return true; }          // the server owns the handle
  async connect() { return { via: 'http' }; }
  async disconnect() {}

  async _api(path, body) {
    const r = await fetch(this.base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  async readAll() {
    const st = await this._api('/api/state');
    return st;
  }

  async readLayer(layer) {
    const st = await this._api('/api/state');
    return (st.layers?.[layer] || []).filter(b => isPhysical(b.key_id));
  }

  async writeBinding(b) {
    // The server speaks the old shape: a target name and a spec string.
    const { target, spec, delays } = toLegacy(b);
    await this._api('/api/set', { target, layer: b.layer, spec, delays });
  }

  async readLeds(layer) { return this._api('/api/state').then(s => s.leds?.[layer - 1]); }

  async writeLeds(layer, mode, colors) {
    await this._api('/api/led', { layer: layer - 1, mode, colors });
  }

  async backup() { return this._api('/api/backup', {}); }
}

/** The wire-format bridge to that API's older request shape. */
function toLegacy(b) {
  const name = keyIdToName(b.keyId);
  if (b.kind === KIND_MOUSE) {
    const m = b.mouse || {};
    return { target: name, spec: mouseName(m), delays: [] };
  }
  return {
    target: name,
    spec: (b.codes || []).map(c => '0x' + c.toString(16)).join('+'),
    delays: b.delays || [],
  };
}

// ---------------------------------------------------------------- WebHID

/** Direct to the device. Chrome and Edge only; file:// cannot use WebHID. */
export class PadWebHid {
  constructor() { this.dev = null; this.isMock = false; this._q = []; }

  get name() { return 'webhid'; }
  /* Test the value, not just the key: a browser can expose the property and
     leave it undefined, and `'hid' in navigator` still says yes. */
  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.hid
        && typeof navigator.hid.requestDevice === 'function';
  }
  isConnected() { return !!(this.dev && this.dev.opened); }

  /** Reuse a previously granted device if there is one, else ask. Asking
   *  requires a user gesture, so `prompt` is only true from a click. */
  async connect({ prompt = true } = {}) {
    const filter = { vendorId: 0x514C, productId: 0x8850,
                     usagePage: 0xFF00, usage: 0x01 };
    let devs = (await navigator.hid.getDevices())
      .filter(d => d.vendorId === filter.vendorId && d.productId === filter.productId
                && d.collections.some(c => c.usagePage === 0xFF00));
    if (!devs.length) {
      if (!prompt) throw new Error('not granted yet');
      devs = await navigator.hid.requestDevice({ filters: [filter] });
    }
    if (!devs.length) throw new Error('no device selected');
    this.dev = devs[0];
    if (!this.dev.opened) await this.dev.open();
    this.dev.addEventListener('inputreport', e => this._onReport(e));
    /* open() resolves before the device is answering: a read issued
       immediately after connecting comes back empty. */
    await sleep(SETTLE_AFTER_OPEN);
    return { via: 'webhid', name: this.dev.productName };
  }

  /** Let go of the device. The permission survives, so connecting again is
   *  silent. */
  async disconnect() {
    if (this.dev?.opened) await this.dev.close();
    this.dev = null;
    this._q.length = 0;
  }

  /** Revoke the permission too, so the next connect has to ask again. */
  async forget() {
    const d = this.dev;
    await this.disconnect();
    if (d && d.forget) await d.forget();
  }

  /** Devices this origin may already open without prompting. */
  static async granted() {
    if (!PadWebHid.supported()) return [];
    return (await navigator.hid.getDevices())
      .filter(d => d.vendorId === 0x514C && d.productId === 0x8850);
  }

  /** Drop every grant for this pad, including ones this page is not holding. */
  static async forgetAll() {
    for (const d of await PadWebHid.granted()) {
      if (d.forget) await d.forget();
    }
  }

  /* Reports arrive as events, so a request and its reply are linked only by
   * order, and binding and LED replies both open with 0xFA -- an LED reply's
   * mode byte sits where a key id would. So a waiter declares what it expects
   * and anything failing that test is discarded. */
  _onReport(e) {
    const bytes = new Uint8Array(e.data.buffer);
    while (this._q.length) {
      const w = this._q[0];
      if (w.accept(bytes)) { w.got.push(bytes); return; }
      // Not for this waiter: stale traffic from an earlier request.
      return;
    }
  }

  async _send(data) {
    // A read can still be in flight when the device is let go.
    if (!this.dev) throw new Error('デバイスが接続されていません');
    await this.dev.sendReport(W.REPORT_ID, data);
  }

  /** Collect reports matching `accept` until `want` of them or the timeout. */
  _collect(accept, want, ms) {
    return new Promise(resolve => {
      const w = { accept, got: [] };
      this._q.push(w);
      const done = () => {
        const i = this._q.indexOf(w);
        if (i >= 0) this._q.splice(i, 1);
        resolve(w.got);
      };
      const t = setInterval(() => { if (w.got.length >= want) { clearInterval(t); done(); } }, 10);
      setTimeout(() => { clearInterval(t); done(); }, ms);
    });
  }

  async readLayer(layer) {
    /* The device sends N_ENTRIES replies but one is the id-25 bookkeeping
       row, which looksLikeBinding rejects -- waiting for N_ENTRIES accepted
       reports would never complete and burn the full timeout. Counting to the
       number of real keys returns as the last one lands: 1200ms -> ~40ms. */
    const p = this._collect(b => W.looksLikeBinding(b), MAX_KEY_ID, 1200);
    await this._send(W.encodeReadLayer(layer));
    const reports = await p;
    /* A reply from a previous request can still arrive inside this window.
       Keeping the last report per key id makes a duplicate harmless. */
    const byKey = new Map();
    for (const r of reports) {
      const b = W.decodeBinding(r);
      if (b && b.layer === layer && isPhysical(b.keyId)) byKey.set(b.keyId, b);
    }
    return [...byKey.values()].sort((a, b) => a.keyId - b.keyId);
  }

  async readAll() {
    const layers = {};
    for (const l of [1, 2, 3]) layers[l] = await this.readLayer(l);
    const leds = [];
    for (const l of [1, 2, 3]) leds.push(await this.readLeds(l));
    return { layers, leds };
  }

  async writeBinding(b) {
    await this._send(W.encodeBinding(b));
    await sleep(WRITE_GAP);
    await this._send(W.encodeCommit());
    await sleep(COMMIT_GAP);
  }

  async readLeds(layer) {
    /* "not a binding" is too weak on its own: a straggler from an earlier
       exchange satisfies it and gets decoded as LED state. An LED reply also
       has a mode in 0..5, so require that too, and drain the queue first. */
    this._q.length = 0;
    const accept = b => b[0] === W.OP_READ && !W.looksLikeBinding(b) && b[1] <= 5;
    const p = this._collect(accept, 1, 900);
    await this._send(W.encodeReadLeds(layer));
    const [r] = await p;
    return r ? W.decodeLeds(r) : null;
  }

  async writeLeds(layer, mode, colors) {
    await this._send(W.encodeLedInit());          // required, else the write is ignored
    await sleep(WRITE_GAP);
    await this._send(W.encodeLeds(layer, mode, colors));
    await sleep(WRITE_GAP);
    await this._send(W.encodeCommit());
    await sleep(COMMIT_GAP);
  }
}

// ------------------------------------------------------------------ mock

/** An in-memory pad. Records every write and reaches no hardware. */
export class PadMock {
  constructor({ layers = {}, leds = [] } = {}) {
    this.isMock = true;
    this.writeLog = [];
    this.layers = { 1: [], 2: [], 3: [], ...layers };
    this.leds = leds.length ? leds : [0, 1, 2].map(() => ({ mode: 0, colors: blank() }));
  }

  get name() { return 'mock'; }
  isConnected() { return true; }
  async connect() { return { via: 'mock' }; }
  async disconnect() {}

  async readAll() { return { layers: this.layers, leds: this.leds }; }
  async readLayer(layer) { return this.layers[layer] || []; }
  async readLeds(layer) { return this.leds[layer - 1]; }

  async writeBinding(b) {
    this.writeLog.push({ op: 'binding', ...b });
    // Encode it anyway: a binding the real driver would reject fails here too.
    W.encodeBinding(b);
    const rows = (this.layers[b.layer] ||= []).filter(x => x.keyId !== b.keyId);
    rows.push({ ...b });
    this.layers[b.layer] = rows.sort((x, y) => x.keyId - y.keyId);
  }

  async writeLeds(layer, mode, colors) {
    this.writeLog.push({ op: 'leds', layer, mode, colors });
    this.leds[layer - 1] = { mode, colors };
  }

  async backup() { return { path: '(mock)' }; }
}

const blank = () => Array.from({ length: 16 }, () => [0, 0, 0]);

/* Names for the legacy HTTP request shape. */
function mouseName(m) {
  if (m.buttons && MOUSE_BUTTONS[m.buttons]) return MOUSE_BUTTONS[m.buttons];
  if (m.wheel > 0) return 'WheelUp';
  if (m.wheel < 0) return 'WheelDown';
  return 'MouseLeft';
}

/** The device if the browser can reach it and the user has already granted
 *  access, otherwise null. */
export async function autoDriver() {
  if (PadWebHid.supported()) {
    const d = new PadWebHid();
    try { await d.connect({ prompt: false }); return d; } catch { /* not granted */ }
  }
  return null;
}
