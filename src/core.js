/*
 * NFSU2 Save Editor — core (sin interfaz).
 * Funciona en el navegador (window.NFSU2Core) y en Node (module.exports),
 * para poder probarlo con `node tests/core.test.js`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NFSU2Core = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Formato de la partida (offsets conocidos)
  // ---------------------------------------------------------------------------
  const LAYOUT = Object.freeze({
    MAGIC: [0x32, 0x30, 0x43, 0x4d],     // "20CM"
    SIZE_OFF: 0x04,                       // uint32: tamaño total del archivo
    DATA_SIZE_OFF: 0x0c,                  // uint32: tamaño - 0x24
    DATA_SIZE_DELTA: 0x24,
    CHECK_OFF: 0x10,                      // 16 bytes: posible suma de verificación (no se toca)
    CHECK_LEN: 0x10,
    MONEY_OFF: 0xa16a,                    // int32 LE
    NAME_OFF: 0xd225,                     // cadena terminada en 0, Windows-1252
    NAME_FIELD: 32,                       // bytes reservados (31 caracteres + terminador)
    SLOTS_OFF: 0x5aec,
    SLOT_SIZE: 0x7f2,
    NUM_SLOTS: 5,
    SLOT_HEADER: 16,                      // bytes que identifican el auto del espacio
    PERF_OFF: 0x94,                       // dentro del espacio
    PERF_LEN: 0x44,
  });

  const MONEY_MAX = 0x7fffffff;

  /**
   * Mejoras al máximo tal como las deja el juego: se escribieron los 68 bytes en 1 y, al volver
   * a guardar, el juego conservó solo estos (0–56, 59 y 62) y puso el resto en 0.
   */
  const PERF_MAX_PATTERN = Uint8Array.from({ length: 0x44 }, (_, i) => (i <= 56 || i === 59 || i === 62 ? 1 : 0));

  // ---------------------------------------------------------------------------
  // Windows-1252 (codificación que usa el juego para el nombre)
  // ---------------------------------------------------------------------------
  const CP1252_HIGH = [
    0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
    null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
  ];
  const UNI_TO_CP = new Map();
  CP1252_HIGH.forEach((u, i) => { if (u !== null) UNI_TO_CP.set(u, 0x80 + i); });

  function cp1252Decode(bytes) {
    let s = '';
    for (const b of bytes) {
      if (b >= 0x80 && b < 0xa0) s += CP1252_HIGH[b - 0x80] !== null ? String.fromCharCode(CP1252_HIGH[b - 0x80]) : '?';
      else s += String.fromCharCode(b);
    }
    return s;
  }

  /** Devuelve los bytes o null si algún carácter no existe en Windows-1252. */
  function cp1252Encode(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
      else if (UNI_TO_CP.has(c)) out.push(UNI_TO_CP.get(c));
      else return null;
    }
    return Uint8Array.from(out);
  }

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hex = (n, w = 8) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

  function slotBase(i) { return LAYOUT.SLOTS_OFF + i * LAYOUT.SLOT_SIZE; }

  function isZero(u8, start, len) {
    for (let i = 0; i < len; i++) if (u8[start + i] !== 0) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------
  function isSave(u8) {
    if (!u8 || u8.length < LAYOUT.NAME_OFF + LAYOUT.NAME_FIELD) return false;
    return LAYOUT.MAGIC.every((b, i) => u8[i] === b);
  }

  function checkHeader(u8) {
    const v = view(u8);
    const magic = LAYOUT.MAGIC.every((b, i) => u8[i] === b);
    const size = u8.length >= 8 ? v.getUint32(LAYOUT.SIZE_OFF, true) : -1;
    const dataSize = u8.length >= 16 ? v.getUint32(LAYOUT.DATA_SIZE_OFF, true) : -1;
    return {
      magic,
      sizeOk: size === u8.length,
      dataSizeOk: dataSize === u8.length - LAYOUT.DATA_SIZE_DELTA,
      big: u8.length >= LAYOUT.NAME_OFF + LAYOUT.NAME_FIELD,
      get ok() { return this.magic && this.sizeOk && this.dataSizeOk && this.big; },
    };
  }

  function readName(u8) {
    let end = LAYOUT.NAME_OFF;
    const max = LAYOUT.NAME_OFF + LAYOUT.NAME_FIELD;
    while (end < max && u8[end] !== 0) end++;
    return cp1252Decode(u8.subarray(LAYOUT.NAME_OFF, end));
  }

  function readMoney(u8) { return view(u8).getInt32(LAYOUT.MONEY_OFF, true); }

  function readSlot(u8, i) {
    const base = slotBase(i);
    const used = !isZero(u8, base, LAYOUT.SLOT_HEADER);
    const perf = u8.subarray(base + LAYOUT.PERF_OFF, base + LAYOUT.PERF_OFF + LAYOUT.PERF_LEN);
    let perfState = 'mixed';
    if (perf.every((b) => b === 0)) perfState = 'stock';
    else if (perf.every((b, k) => b === PERF_MAX_PATTERN[k]) || perf.every((b) => b === 1)) perfState = 'max';
    return {
      index: i,
      used,
      carId: used ? view(u8).getUint32(base, true) : 0,
      carIdHex: used ? hex(view(u8).getUint32(base, true)) : '',
      perfState,
    };
  }

  function readSlots(u8) {
    const out = [];
    for (let i = 0; i < LAYOUT.NUM_SLOTS; i++) out.push(readSlot(u8, i));
    return out;
  }

  function readSummary(u8) {
    const slots = readSlots(u8);
    return {
      name: readName(u8),
      money: readMoney(u8),
      slots,
      usedSlots: slots.filter((s) => s.used).length,
      header: checkHeader(u8),
      size: u8.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Escritura (todas modifican u8 en su lugar y lanzan Error con código si algo falla)
  // ---------------------------------------------------------------------------
  function err(code, extra) { const e = new Error(code); e.code = code; Object.assign(e, extra || {}); return e; }

  function validateName(name) {
    if (typeof name !== 'string' || name.length === 0) throw err('NAME_EMPTY');
    const bytes = cp1252Encode(name);
    if (!bytes) throw err('NAME_CHARS');
    if (bytes.length > LAYOUT.NAME_FIELD - 1) throw err('NAME_LONG', { max: LAYOUT.NAME_FIELD - 1 });
    return bytes;
  }

  function writeName(u8, name) {
    const bytes = validateName(name);
    for (let i = 0; i < LAYOUT.NAME_FIELD; i++) u8[LAYOUT.NAME_OFF + i] = i < bytes.length ? bytes[i] : 0;
  }

  function validateMoney(value) {
    if (!Number.isInteger(value)) throw err('MONEY_INT');
    if (value < 0 || value > MONEY_MAX) throw err('MONEY_RANGE', { max: MONEY_MAX });
    return value;
  }

  function writeMoney(u8, value) { view(u8).setInt32(LAYOUT.MONEY_OFF, validateMoney(value), true); }

  function setPerformance(u8, i, mode) {
    if (mode !== 'stock' && mode !== 'max') throw err('PERF_MODE');
    const s = readSlot(u8, i);
    if (!s.used) throw err('SLOT_EMPTY');
    const base = slotBase(i) + LAYOUT.PERF_OFF;
    if (mode === 'max') u8.set(PERF_MAX_PATTERN, base);
    else u8.fill(0, base, base + LAYOUT.PERF_LEN);
  }

  /** Copia un espacio completo (auto + piezas) a un espacio vacío. Experimental. */
  function duplicateSlot(u8, from, to) {
    if (!readSlot(u8, from).used) throw err('SLOT_EMPTY');
    if (readSlot(u8, to).used) throw err('SLOT_TAKEN');
    u8.copyWithin(slotBase(to), slotBase(from), slotBase(from) + LAYOUT.SLOT_SIZE);
  }

  /** Devuelve un espacio a como estaba en el archivo original. */
  function restoreSlot(u8, original, i) {
    const b = slotBase(i);
    u8.set(original.subarray(b, b + LAYOUT.SLOT_SIZE), b);
  }

  // ---------------------------------------------------------------------------
  // Comparación (para mostrar los cambios antes de descargar)
  // ---------------------------------------------------------------------------
  function diff(original, edited) {
    const a = readSummary(original);
    const b = readSummary(edited);
    const changes = [];
    if (a.name !== b.name) changes.push({ field: 'name', from: a.name, to: b.name });
    if (a.money !== b.money) changes.push({ field: 'money', from: a.money, to: b.money });
    for (let i = 0; i < LAYOUT.NUM_SLOTS; i++) {
      const sa = a.slots[i], sb = b.slots[i];
      if (sa.used !== sb.used || sa.carId !== sb.carId) changes.push({ field: 'slot', slot: i, from: sa, to: sb });
      else if (sa.perfState !== sb.perfState) changes.push({ field: 'perf', slot: i, from: sa.perfState, to: sb.perfState });
    }
    let bytes = 0;
    for (let i = 0; i < original.length; i++) if (original[i] !== edited[i]) bytes++;
    return { changes, bytes };
  }

  // ---------------------------------------------------------------------------
  // ZIP (lectura con deflate y escritura sin compresión), sin librerías externas
  // ---------------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw err('ZIP_NO_INFLATE');
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function isZip(u8) { return u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04; }

  async function readZip(u8) {
    const v = view(u8);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw err('ZIP_BAD');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw err('ZIP_BAD');
      const flags = v.getUint16(p + 8, true);
      const method = v.getUint16(p + 10, true);
      const time = v.getUint16(p + 12, true);
      const date = v.getUint16(p + 14, true);
      const compSize = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const localOff = v.getUint32(p + 42, true);
      const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : cp1252Decode(nameBytes);
      p += 46 + nameLen + extraLen + commentLen;

      const lNameLen = v.getUint16(localOff + 26, true);
      const lExtraLen = v.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + compSize);
      let data;
      if (name.endsWith('/')) data = new Uint8Array(0);
      else if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw err('ZIP_METHOD', { method });
      entries.push({ name, data, time, date, dir: name.endsWith('/') });
    }
    return entries;
  }

  /** Crea un zip sin compresión (método "store"), conservando nombres y fechas. */
  function writeZip(entries) {
    const enc = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const data = e.data || new Uint8Array(0);
      const crc = crc32(data);
      const time = e.time ?? 0, date = e.date ?? 0x21;
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = view(lh);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = view(ch);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint32(38, e.dir ? 0x10 : 0, true); cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      locals.push(lh, data); centrals.push(ch);
      offset += lh.length + data.length;
    }
    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = view(end);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, end];
    const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Visor de bytes
  // ---------------------------------------------------------------------------
  function hexDump(u8, start, length, original) {
    const lines = [];
    const from = Math.max(0, start - (start % 16));
    const to = Math.min(u8.length, start + length);
    for (let row = from; row < to; row += 16) {
      const cells = [];
      let ascii = '';
      for (let i = row; i < row + 16 && i < u8.length; i++) {
        cells.push({ value: u8[i], changed: !!original && original[i] !== u8[i] });
        ascii += u8[i] >= 0x20 && u8[i] < 0x7f ? String.fromCharCode(u8[i]) : '.';
      }
      lines.push({ offset: row, cells, ascii });
    }
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Comparador de partidas
  // ---------------------------------------------------------------------------
  /** Nombre de la zona conocida a la que pertenece un offset (clave de traducción + datos). */
  function zoneOf(off) {
    const L = LAYOUT;
    if (off < 0x10) return { key: 'zoneHeader' };
    if (off < L.CHECK_OFF + L.CHECK_LEN) return { key: 'zoneChecksum' };
    if (off < L.DATA_SIZE_DELTA) return { key: 'zoneHeader' };
    const slotsEnd = L.SLOTS_OFF + L.NUM_SLOTS * L.SLOT_SIZE;
    if (off >= L.SLOTS_OFF && off < slotsEnd) {
      const n = Math.floor((off - L.SLOTS_OFF) / L.SLOT_SIZE);
      const rel = off - slotBase(n);
      if (rel < L.SLOT_HEADER) return { key: 'zoneSlotId', n: n + 1 };
      if (rel >= L.PERF_OFF && rel < L.PERF_OFF + L.PERF_LEN) return { key: 'zoneSlotPerf', n: n + 1 };
      return { key: 'zoneSlot', n: n + 1, rel };
    }
    if (off >= L.MONEY_OFF && off < L.MONEY_OFF + 4) return { key: 'zoneMoney' };
    if (off >= L.NAME_OFF && off < L.NAME_OFF + L.NAME_FIELD) return { key: 'zoneName' };
    return { key: 'zoneUnknown' };
  }

  /**
   * Zonas que cambian entre dos partidas. Junta cambios separados por menos de `gap` bytes
   * y corta cada zona en el borde de las zonas conocidas, para que cada fila tenga una sola etiqueta.
   */
  function compareSaves(a, b, gap = 4) {
    const len = Math.min(a.length, b.length);
    const raw = [];
    let start = -1;
    for (let i = 0; i <= len; i++) {
      const d = i < len && a[i] !== b[i];
      if (d && start < 0) start = i;
      if (!d && start >= 0) { raw.push([start, i]); start = -1; }
    }
    const merged = [];
    for (const r of raw) {
      const last = merged[merged.length - 1];
      const sameZone = last && zoneOf(last[0]).key === zoneOf(r[0]).key && zoneOf(last[0]).n === zoneOf(r[0]).n;
      if (last && r[0] - last[1] < gap && sameZone) last[1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    return {
      sizeA: a.length,
      sizeB: b.length,
      bytes: raw.reduce((s, [p, q]) => s + q - p, 0),
      regions: merged.map(([p, q]) => {
        const before = a.subarray(p, q), after = b.subarray(p, q);
        const num = (u) => {
          if (u.length > 4) return null;
          let v = 0;
          for (let i = u.length - 1; i >= 0; i--) v = v * 256 + u[i];
          return v;
        };
        return { start: p, length: q - p, before: before.slice(), after: after.slice(), numBefore: num(before), numAfter: num(after), zone: zoneOf(p) };
      }),
    };
  }

  return {
    LAYOUT, MONEY_MAX, PERF_MAX_PATTERN, hex, zoneOf, compareSaves,
    isSave, checkHeader, readSummary, readSlots, readName, readMoney,
    validateName, validateMoney, writeName, writeMoney,
    setPerformance, duplicateSlot, restoreSlot, diff,
    isZip, readZip, writeZip, crc32, hexDump,
    cp1252Encode, cp1252Decode,
  };
});
