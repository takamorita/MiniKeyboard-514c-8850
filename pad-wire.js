/* pad-wire.js -- bytes in, bindings out. Pure functions, no I/O.
 *
 * Report layout, once the report ID is out of the way:
 *   write  [0xFD] [key_id] [layer] [kind] [n_mods] [n_keys] <payload from 6>
 *   read   [0xFA] [key_id] [layer] [kind] [n_mods] [n_keys] <payload from 6>
 * Write index i lines up with read index i.
 */

import {
  KIND_KEYBOARD, KIND_MEDIA, KIND_MOUSE, LED_SLOTS, MAX_CODES,
  isMod, isPhysical,
} from './catalog.js';

export const REPORT_ID = 0x03;
export const PACKET = 64;        // data bytes after the report ID
export const N_ENTRIES = 25;     // bindings returned by one read request

export const OP_WRITE = 0xFD;
export const OP_READ = 0xFA;
export const OP_LED = 0xB0;
export const CMD_COMMIT = [0xFD, 0xFE, 0xFF];
export const CMD_LED_INIT = [0xFB, 0xFB, 0xFB];

/* Payload starts at 6. Keyboard slots are 3-byte groups from there, so the
 * usages land at 8, 11, 14... with each usage's delay in the two bytes
 * immediately before it. */
const PAYLOAD = 6;
const SLOT = 3;
const usageAt = i => PAYLOAD + i * SLOT + 2;

/* Mouse does not follow the 3-byte grouping: button bits and wheel sit at
 * fixed, non-adjacent offsets. A packet that stops short of the wheel is
 * silently truncated by the firmware. */
const MOUSE_MOD = 8;
const MOUSE_BUTTON = 11;
const MOUSE_WHEEL = 20;

// ------------------------------------------------------------- encoding

/** A binding -> the 64 data bytes to hand to sendReport(0x03, ...). */
export function encodeBinding(b) {
  if (!b || typeof b !== 'object') throw new Error('binding: not an object');
  if (!isPhysical(b.keyId)) throw new Error('binding: bad keyId ' + b.keyId);
  if (!(b.layer >= 1 && b.layer <= 3)) throw new Error('binding: bad layer ' + b.layer);
  if (![KIND_KEYBOARD, KIND_MEDIA, KIND_MOUSE].includes(b.kind)) {
    throw new Error('binding: bad kind ' + b.kind);
  }
  if (b.kind === KIND_MOUSE) {
    if (b.mouse && typeof b.mouse !== 'object') throw new Error('binding: bad mouse');
  } else {
    if (!Array.isArray(b.codes)) throw new Error('binding: codes must be an array');
    if (b.delays !== undefined && !Array.isArray(b.delays)) {
      throw new Error('binding: delays must be an array');
    }
    if (b.codes.length > MAX_CODES) {
      throw new Error('binding: ' + b.codes.length + ' slots exceeds ' + MAX_CODES);
    }
  }
  const p = new Uint8Array(PACKET);
  p[0] = OP_WRITE;
  p[1] = b.keyId;
  p[2] = b.layer;
  p[3] = b.kind;

  if (b.kind === KIND_MOUSE) {
    const m = b.mouse || {};
    // n_mods/n_keys are not validated by the device; these are the values
    // the vendor writes, kept for byte-identical output.
    p[4] = 1;
    p[5] = 4;
    if (m.mod) p[MOUSE_MOD] = m.mod;
    if (m.buttons) p[MOUSE_BUTTON] = m.buttons;
    if (m.wheel) p[MOUSE_WHEEL] = m.wheel & 0xFF;   // signed: -1 -> 0xFF
    return p;
  }

  if (b.kind === KIND_MEDIA) {
    // A 16-bit consumer usage, split low/high across two slots. Writing only
    // the low byte makes Bass/Treble unreachable.
    const usage = b.codes[0] | 0;
    p[4] = 0;
    p[5] = 2;
    p[usageAt(0)] = usage & 0xFF;
    p[usageAt(1)] = (usage >> 8) & 0xFF;
    return p;
  }

  const codes = b.codes || [];
  const delays = b.delays || [];
  p[4] = 0;                 // the vendor writes 0 here for ordinary macros
  p[5] = codes.length;
  codes.forEach((c, i) => {
    const at = usageAt(i);
    const ms = delays[i] | 0;
    p[at - 2] = (ms >> 8) & 0xFF;   // 16-bit big-endian, full 0..65535 works
    p[at - 1] = ms & 0xFF;
    p[at] = c;
  });
  return p;
}

/** Ask for every binding on a layer. Layer is 1-based here. */
export function encodeReadLayer(layer) {
  const p = new Uint8Array(PACKET);
  p.set([OP_READ, N_ENTRIES, 0x00, layer]);
  return p;
}

/** Ask for a layer's LEDs. Layer is 1-based here and converted on the wire:
 *  LED commands are 0-based while bindings are 1-based. */
export function encodeReadLeds(layer) {
  const p = new Uint8Array(PACKET);
  p.set([OP_READ, OP_LED, layer - 1]);
  return p;
}

/** The LED write payload. Must be preceded by CMD_LED_INIT and followed by
 *  CMD_COMMIT; the driver owns that sequencing. */
export function encodeLeds(layer, mode, colors) {
  const p = new Uint8Array(PACKET);
  p.set([0xFE, OP_LED, layer - 1, mode]);
  for (let i = 0; i < LED_SLOTS; i++) {
    const [r, g, bl] = colors[i] || [0, 0, 0];
    p[4 + i * 3] = r; p[5 + i * 3] = g; p[6 + i * 3] = bl;
  }
  return p;
}

export function encodeCommit() {
  const p = new Uint8Array(PACKET);
  p.set(CMD_COMMIT);
  return p;
}

export function encodeLedInit() {
  const p = new Uint8Array(PACKET);
  p.set(CMD_LED_INIT);
  return p;
}

// ------------------------------------------------------------- decoding

/** A read report -> a binding, or null if it is not one. */
export function decodeBinding(bytes) {
  const r = toBytes(bytes);
  if (r[0] !== OP_READ) return null;
  const kind = r[3];
  const out = {
    keyId: r[1], layer: r[2], kind,
    codes: [], delays: [],
  };

  if (kind === KIND_MOUSE) {
    out.mouse = {
      mod: r[MOUSE_MOD] || 0,
      buttons: r[MOUSE_BUTTON] || 0,
      // The wheel byte is signed: 0xFF means one click down, not 255.
      wheel: r[MOUSE_WHEEL] ? (r[MOUSE_WHEEL] << 24 >> 24) : 0,
    };
    return out;
  }

  if (kind === KIND_MEDIA) {
    const usage = r[usageAt(0)] | (r[usageAt(1)] << 8);
    if (usage) { out.codes = [usage]; out.delays = [0]; }
    return out;
  }

  for (let i = 0; ; i++) {
    const at = usageAt(i);
    if (at >= r.length || !r[at]) break;
    out.codes.push(r[at]);
    out.delays.push((r[at - 2] << 8) | r[at - 1]);
  }
  return out;
}

/** An LED read report -> {mode, colors}. */
export function decodeLeds(bytes) {
  const r = toBytes(bytes);
  if (r[0] !== OP_READ) return null;
  const colors = [];
  for (let i = 0; i < LED_SLOTS; i++) {
    colors.push([r[2 + i * 3], r[3 + i * 3], r[4 + i * 3]]);
  }
  return { mode: r[1], colors };
}

/* Binding and LED replies both start with 0xFA and are indistinguishable by
 * shape -- byte 1 is a key id in one and a mode in the other. Callers must
 * know which they asked for; this only reports what a report could be. */
export function looksLikeBinding(bytes) {
  const r = toBytes(bytes);
  return r[0] === OP_READ && r[1] >= 1 && r[1] <= 24 &&
         r[2] >= 1 && r[2] <= 3 && r[3] >= 1 && r[3] <= 3;
}

// --------------------------------------------------------------- helpers

/** Modifiers occupy slots like any other usage, so cost is just the count. */
export const slotCost = codes => codes.length;

/** Split a flat code list into chips: runs of modifiers fold into the key
 *  that follows them, and a trailing run stands alone. */
export function foldMods(codes, delays = []) {
  const out = [];
  let pending = [];
  codes.forEach((c, i) => {
    if (isMod(c)) { pending.push(c); return; }
    out.push({ code: c, mods: pending, ms: delays[i] | 0 });
    pending = [];
  });
  if (pending.length) {
    out.push({ code: pending[0], mods: pending.slice(1), ms: 0 });
  }
  return out;
}

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return Uint8Array.from(x);
}
