// Pruebas del núcleo: npm test  ·  node tests/core.test.js [ruta-a-una-partida-real]
//
// Sin argumento usan una partida sintética generada aquí mismo, así que funcionan sin
// archivos personales. Para probar con una partida real, pásala como argumento o
// déjala en tests/fixtures/ (esa carpeta está en .gitignore).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/core.js');

/** Partida mínima con la misma estructura que una real (cabecera, dinero, nombre, 1 auto). */
function syntheticSave() {
  const L = C.LAYOUT;
  const size = 54966;
  const u8 = new Uint8Array(size);
  const v = new DataView(u8.buffer);
  u8.set(L.MAGIC, 0);
  v.setUint32(L.SIZE_OFF, size, true);
  v.setUint32(8, 8, true);
  v.setUint32(L.DATA_SIZE_OFF, size - L.DATA_SIZE_DELTA, true);
  v.setInt32(L.MONEY_OFF, 2000, true);
  u8.set(new TextEncoder().encode('Tester'), L.NAME_OFF);
  v.setUint32(L.SLOTS_OFF, 0x12345678, true);
  v.setUint32(L.SLOTS_OFF + 4, 0x9abcdef0, true);
  return u8;
}

function findFixture() {
  if (process.argv[2]) return process.argv[2];
  const dir = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => {
    try { return fs.statSync(p).isFile() && C.isSave(new Uint8Array(fs.readFileSync(p))); } catch { return false; }
  });
  return f || null;
}

const savePath = findFixture();
const original = savePath ? new Uint8Array(fs.readFileSync(savePath)) : syntheticSave();
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
}

(async () => {
  console.log('Partida:', savePath || 'sintética (sin archivos personales)');

  await test('reconoce la partida y la cabecera', () => {
    assert.ok(C.isSave(original));
    assert.ok(C.checkHeader(original).ok);
  });

  await test('lee nombre, dinero y garaje', () => {
    const s = C.readSummary(original);
    assert.equal(typeof s.name, 'string');
    assert.ok(s.name.length > 0);
    assert.ok(Number.isInteger(s.money) && s.money >= 0);
    assert.ok(s.usedSlots >= 1);
    console.log('        ', JSON.stringify({ name: s.name, money: s.money, cars: s.usedSlots }));
  });

  await test('escribe el dinero sin tocar nada más', () => {
    const w = original.slice();
    C.writeMoney(w, 1234567);
    assert.equal(C.readMoney(w), 1234567);
    const d = C.diff(original, w);
    assert.equal(d.changes.length, 1);
    assert.ok(d.bytes <= 4);
  });

  await test('rechaza dinero inválido', () => {
    const w = original.slice();
    assert.throws(() => C.writeMoney(w, -5), { code: 'MONEY_RANGE' });
    assert.throws(() => C.writeMoney(w, 2 ** 31), { code: 'MONEY_RANGE' });
    assert.throws(() => C.writeMoney(w, 1.5), { code: 'MONEY_INT' });
    assert.deepEqual(w, original);
  });

  await test('nombres con tildes y ñ se guardan bien', () => {
    const w = original.slice();
    C.writeName(w, 'Muñoz Andrés');
    assert.equal(C.readName(w), 'Muñoz Andrés');
    const n = C.LAYOUT.NAME_OFF + 'Muñoz Andrés'.length;
    assert.equal(w[n], 0, 'termina en 0');
  });

  await test('nombre: límites', () => {
    const w = original.slice();
    assert.throws(() => C.writeName(w, ''), { code: 'NAME_EMPTY' });
    assert.throws(() => C.writeName(w, 'x'.repeat(32)), { code: 'NAME_LONG' });
    assert.throws(() => C.writeName(w, 'emoji 😀'), { code: 'NAME_CHARS' });
    C.writeName(w, 'x'.repeat(31));
    assert.equal(w[C.LAYOUT.NAME_OFF + 31], 0);
  });

  await test('rendimiento al máximo y deshacer el espacio', () => {
    const w = original.slice();
    const i = C.readSlots(w).find((s) => s.used).index;
    C.setPerformance(w, i, 'max');
    assert.equal(C.readSlots(w)[i].perfState, 'max');
    C.restoreSlot(w, original, i);
    assert.deepEqual(w, original);
  });

  await test('duplicar auto en espacio vacío', () => {
    const w = original.slice();
    const slots = C.readSlots(w);
    const from = slots.find((s) => s.used).index;
    const to = slots.find((s) => !s.used).index;
    C.duplicateSlot(w, from, to);
    assert.equal(C.readSlots(w)[to].carId, slots[from].carId);
    assert.throws(() => C.duplicateSlot(w, from, to), { code: 'SLOT_TAKEN' });
  });

  await test('la cabecera y la zona 0x10–0x1F no cambian al editar', () => {
    const w = original.slice();
    C.writeMoney(w, 999999); C.writeName(w, 'Prueba');
    assert.deepEqual(w.subarray(0, 0x24), original.subarray(0, 0x24));
  });

  await test('zip: escribe y vuelve a leer igual', async () => {
    const entries = [
      { name: 'saves/', data: new Uint8Array(0), dir: true },
      { name: 'NFS Underground 2/Tester/Tester', data: original },
      { name: 'saves/otro.txt', data: new TextEncoder().encode('hola') },
    ];
    const zip = C.writeZip(entries);
    assert.ok(C.isZip(zip));
    const back = await C.readZip(zip);
    assert.equal(back.length, 3);
    assert.deepEqual(back[1].data, original);
    assert.equal(back[1].name, 'NFS Underground 2/Tester/Tester');
  });

  await test('zip: lee archivos comprimidos (deflate)', async () => {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-'));
    fs.mkdirSync(path.join(dir, 'P1'));
    fs.writeFileSync(path.join(dir, 'P1', 'P1'), original);
    try { execFileSync('zip', ['-r', '-q', 'out.zip', 'P1'], { cwd: dir }); }
    catch { console.log('         (sin comando zip; se omite)'); return; }
    const back = await C.readZip(new Uint8Array(fs.readFileSync(path.join(dir, 'out.zip'))));
    const save = back.find((e) => C.isSave(e.data));
    assert.ok(save);
    assert.deepEqual(save.data, original);
  });

  await test('comparador: detecta dinero y nombre en su zona', () => {
    const w = original.slice();
    C.writeMoney(w, 777777); C.writeName(w, 'Otro');
    const r = C.compareSaves(original, w);
    const keys = r.regions.map((x) => x.zone.key);
    assert.ok(keys.includes('zoneMoney'));
    assert.ok(keys.includes('zoneName'));
    assert.equal(C.compareSaves(original, original.slice()).regions.length, 0);
  });

  await test('comparador: valores numéricos y zonas del garaje', () => {
    const w = original.slice();
    w[0xc29a] = w[0xc29a] + 1;
    C.setPerformance(w, 0, 'max');
    const r = C.compareSaves(original, w);
    const u = r.regions.find((x) => x.start === 0xc29a);
    assert.equal(u.zone.key, 'zoneUnknown');
    assert.equal(u.numAfter, u.numBefore + 1);
    assert.ok(r.regions.some((x) => x.zone.key === 'zoneSlotPerf' && x.zone.n === 1));
  });

  await test('settings.ini: ida y vuelta sin cambios, y edición de una línea', () => {
    const S = require('../src/settings.js');
    const txt = [
      '# ---- Game ----', '', '# Language.', 'language = spanish', '', '# FPS counter.', '#fps_counter = off', '',
      '# Dead zones.', '#gamepad_deadzone = 0.08', '#gamepad_trigger_deadzone = 0.02',
    ].join('\r\n');
    const doc = S.parse(txt);
    assert.equal(S.serialize(doc), txt);
    assert.equal(doc.options.find((o) => o.key === 'gamepad_trigger_deadzone').description, 'Dead zones.');
    S.setValue(doc, 'fps_counter', 'on');
    assert.ok(S.serialize(doc).includes('\r\nfps_counter = on\r\n'));
    S.setValue(doc, 'fps_counter', 'off'); // vuelve al predeterminado: queda comentada
    assert.equal(S.serialize(doc), txt);
    S.setValue(doc, 'language', 'english');
    assert.deepEqual(S.changed(doc).map((o) => o.key), ['language']);
    S.resetValue(doc, 'language');
    assert.equal(S.serialize(doc), txt);
  });

  await test('registry.txt: ida y vuelta y edición de un valor', () => {
    const S = require('../src/settings.js');
    const txt = 'd NotFirstTime=1\nd g_MotionBlurEnable=1\nd g_CarShadowEnable=2\nd g_FSAALevel=4294967295\n';
    const doc = S.parseRegistry(txt);
    assert.equal(S.serializeRegistry(doc), txt);
    assert.ok(doc.entries.find((e) => e.key === 'NotFirstTime').hidden);
    assert.ok(doc.entries.find((e) => e.key === 'g_MotionBlurEnable').toggle);
    assert.ok(!doc.entries.find((e) => e.key === 'g_CarShadowEnable').toggle);
    S.setRegistry(doc, 'g_MotionBlurEnable', '0');
    assert.equal(S.serializeRegistry(doc), txt.replace('g_MotionBlurEnable=1', 'g_MotionBlurEnable=0'));
    assert.throws(() => S.setRegistry(doc, 'g_CarShadowEnable', '-1'), { code: 'REG_NUMBER' });
  });

  await test('mejoras al máximo usan el patrón que conserva el juego', () => {
    const w = original.slice();
    C.setPerformance(w, 0, 'max');
    const base = C.LAYOUT.SLOTS_OFF + C.LAYOUT.PERF_OFF;
    assert.deepEqual(w.subarray(base, base + C.LAYOUT.PERF_LEN), C.PERF_MAX_PATTERN);
    assert.equal(C.readSlots(w)[0].perfState, 'max');
  });

  console.log(`\n${passed} pruebas correctas`);
})();
