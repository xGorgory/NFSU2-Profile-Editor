/* NFSU2 Save Editor — interfaz */
(function () {
  'use strict';
  const C = window.NFSU2Core;
  const { t, fmt } = window.I18N;
  const $ = (s) => document.querySelector(s);

  const state = {
    source: null,   // { kind: 'file'|'zip', name, rawBytes, entries?, saveIndexes?, entryIndex? }
    original: null, // Uint8Array de la partida tal como se abrió
    work: null,     // copia que se edita
    history: [],    // copias anteriores para "Deshacer"
    hexOffset: 0xa160,
  };

  // ---------------------------------------------------------------------------
  // Utilidades de interfaz
  // ---------------------------------------------------------------------------
  let toastTimer;
  function toast(msg, bad) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  function errText(e) {
    if (e && e.code) return t('err' + e.code, { max: fmt(e.max ?? '') });
    return String(e && e.message || e);
  }

  // Publicado en claude.ai, la página no puede descargar archivos por sí sola: usa la capacidad
  // "downloads" (el visitante confirma cada archivo). Abierto como archivo local, usa un enlace normal.
  let downloadsCap;
  function getDownloads() {
    if (downloadsCap === undefined) {
      downloadsCap = window.claude && typeof window.claude.use === 'function'
        ? window.claude.use('downloads').catch(() => null)
        : Promise.resolve(null);
    }
    return downloadsCap;
  }
  const ALLOWED_EXT = /\.(zip|json|csv|txt|md|png)$/i;

  /** Devuelve true si el archivo se entregó (o se intentó entregar con un enlace). */
  async function download(bytes, filename) {
    const cap = await getDownloads();
    if (cap) {
      let name = filename, data = bytes;
      // la partida no tiene extensión: se entrega dentro de un zip
      if (!ALLOWED_EXT.test(name)) { data = C.writeZip([{ name: filename.replace(/\.bak$/i, ''), data: bytes }]); name = filename + '.zip'; }
      try { await cap.save({ filename: name, data: new Blob([data]) }); return true; }
      catch (e) {
        if (e && e.code !== 'declined') toast(t('dlFailed'), true);
        return false;
      }
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** Aplica una edición guardando antes una copia para poder deshacer. */
  function edit(fn) {
    const snapshot = state.work.slice();
    fn(state.work);
    state.history.push(snapshot);
    if (state.history.length > 50) state.history.shift();
    render();
  }

  // ---------------------------------------------------------------------------
  // Carga de archivos
  // ---------------------------------------------------------------------------
  async function openFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ok = await openBytes(bytes, file.name);
    if (ok) recordHistory(file.name, 'opened', bytes);
  }

  async function openBytes(bytes, fileName) {
    const file = { name: fileName };
    $('#loadError').textContent = '';
    $('#zipPick').hidden = true;
    try {
      if (C.isZip(bytes)) {
        const entries = await C.readZip(bytes);
        const saveIndexes = entries.map((e, i) => (!e.dir && C.isSave(e.data) ? i : -1)).filter((i) => i >= 0);
        if (!saveIndexes.length) throw Object.assign(new Error(), { ui: 'noSaveInZip' });
        state.source = { kind: 'zip', name: file.name, rawBytes: bytes, entries, saveIndexes };
        $('#fileInfo').textContent = t('loadedZip', { name: file.name, count: entries.filter((e) => !e.dir).length });
        const sel = $('#zipSelect');
        sel.innerHTML = '';
        for (const i of saveIndexes) {
          const o = document.createElement('option');
          o.value = i; o.textContent = `${entries[i].name} — ${C.readName(entries[i].data)}`;
          sel.appendChild(o);
        }
        $('#zipPick').hidden = saveIndexes.length < 2;
        loadSettings(entries);
        loadRegistry(entries);
        loadCovers(entries);
        loadSave(saveIndexes[0]);
      } else {
        if (!C.isSave(bytes)) throw Object.assign(new Error(), { ui: 'notASave' });
        state.source = { kind: 'file', name: file.name, rawBytes: bytes };
        loadSettings([]);
        loadRegistry([]);
        loadCovers([]);
        $('#fileInfo').textContent = t('loadedFile', { name: file.name, size: fmt(bytes.length) });
        loadSave(null);
      }
      return true;
    } catch (e) {
      const key = e.ui || (e.code === 'ZIP_NO_INFLATE' ? 'zipNoInflate' : e.code && e.code.startsWith('ZIP') ? 'zipBad' : null);
      $('#loadError').textContent = key ? t(key) : String(e.message || e);
      hideEditor();
      return false;
    }
  }

  function loadSave(entryIndex) {
    const src = state.source;
    let bytes;
    if (src.kind === 'zip') {
      // Si ya había cambios en otra partida del zip, se guardan dentro del zip en memoria.
      if (src.entryIndex != null && state.work) src.entries[src.entryIndex].data = state.work.slice();
      src.entryIndex = entryIndex;
      bytes = src.entries[entryIndex].data;
      if (!src.originals) src.originals = {};
      if (!src.originals[entryIndex]) src.originals[entryIndex] = bytes.slice();
      state.original = src.originals[entryIndex];
    } else {
      bytes = src.rawBytes;
      state.original = bytes.slice();
    }
    state.work = bytes.slice();
    state.history = [];
    ['#summary', '#editor', '#garageCard', '#output', '#hexCard'].forEach((s) => { $(s).hidden = false; });
    $('#name').value = C.readName(state.work);
    $('#money').value = C.readMoney(state.work);
    $('#nameErr').textContent = ''; $('#moneyErr').textContent = '';
    updateUseButtons();
    render();
  }

  function hideEditor() {
    ['#summary', '#editor', '#garageCard', '#output', '#hexCard', '#settingsCard', '#registryCard', '#coversCard'].forEach((s) => { $(s).hidden = true; });
    state.work = null; state.original = null; state.settings = null; state.registry = null;
    updateUseButtons();
  }

  // ---------------------------------------------------------------------------
  // settings.ini
  // ---------------------------------------------------------------------------
  const S = window.NFSU2Settings;

  function loadSettings(entries) {
    const idx = entries.findIndex((e) => !e.dir && /(^|\/)settings\.ini$/i.test(e.name));
    if (idx < 0) { state.settings = null; $('#settingsCard').hidden = true; return; }
    const text = new TextDecoder().decode(entries[idx].data);
    state.settings = { index: idx, text, doc: S.parse(text) };
    $('#settingsCard').hidden = false;
  }

  const optLabel = (key) => { const l = t('lbl_' + key); return l === 'lbl_' + key ? key : l; };
  const optValueLabel = (o, v) => (o.defaultValue !== null && v === o.defaultValue ? `${v || '—'} ${t('valDefault')}` : (v || '—'));

  function renderSettings() {
    const box = $('#settingsList');
    if (!state.settings) { box.innerHTML = ''; return; }
    const doc = state.settings.doc;
    const q = $('#setSearch').value.trim().toLowerCase();
    const only = $('#setOnlyChanged').checked;
    const changedKeys = new Set(S.changed(doc).map((o) => o.key));
    box.innerHTML = '';
    let shown = 0;
    for (const section of doc.sections) {
      const opts = doc.options.filter((o) => o.section === section)
        .filter((o) => !only || changedKeys.has(o.key))
        .filter((o) => !q || (o.key + ' ' + optLabel(o.key) + ' ' + o.description).toLowerCase().includes(q));
      if (!opts.length) continue;
      const h = document.createElement('div');
      h.className = 'set-section';
      const secLabel = t('sec_' + section);
      h.textContent = secLabel === 'sec_' + section ? section : secLabel;
      box.appendChild(h);
      for (const o of opts) { box.appendChild(settingRow(o, changedKeys.has(o.key))); shown++; }
    }
    if (!shown) box.innerHTML = `<p class="muted">${t('setNone')}</p>`;
  }

  function settingRow(o, isChanged) {
    const row = document.createElement('div');
    row.className = 'set-row' + (isChanged ? ' changed' : '') + (o.active ? ' custom' : '');

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = optLabel(o.key);
    const meta = document.createElement('div');
    meta.innerHTML = `<span class="k"></span> · <span class="st"></span>`;
    meta.querySelector('.k').textContent = o.key;
    meta.querySelector('.st').textContent = o.active ? t('setCustom') : t('setDefault');
    info.append(name, meta);

    let control;
    if (o.choices) {
      control = document.createElement('select');
      const values = o.choices.includes(o.value) ? o.choices : [o.value, ...o.choices];
      for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = optValueLabel(o, v);
        control.appendChild(opt);
      }
      control.value = o.value;
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.value = o.value;
      if (o.defaultValue !== null) control.placeholder = o.defaultValue || '—';
    }
    control.setAttribute('aria-label', optLabel(o.key));
    control.addEventListener('change', () => { S.setValue(state.settings.doc, o.key, control.value); renderSettings(); renderChanges(); });

    const reset = document.createElement('button');
    reset.className = 'small';
    reset.textContent = t('setReset');
    reset.disabled = !isChanged;
    reset.addEventListener('click', () => { S.resetValue(state.settings.doc, o.key); renderSettings(); renderChanges(); });

    row.append(info, control, reset);
    if (o.description) {
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = t('setDesc');
      const p = document.createElement('p');
      p.style.margin = '6px 0 0';
      p.textContent = o.description;
      d.append(s, p);
      row.appendChild(d);
    }
    return row;
  }

  $('#setSearch').addEventListener('input', renderSettings);
  $('#setOnlyChanged').addEventListener('change', renderSettings);

  // ---------------------------------------------------------------------------
  // Portadas de DVD / revista (archivos "<perfil> DVD n" del respaldo)
  // ---------------------------------------------------------------------------
  function loadCovers(entries) {
    const covers = entries.filter((e) => !e.dir && C.isCover(e.data));
    const box = $('#covers');
    box.innerHTML = '';
    $('#coversCard').hidden = !covers.length;
    for (const e of covers) {
      const { width, height, data } = C.coverToRGBA(e.data);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
      const title = e.name.split('/').pop();
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', title);
      const fig = document.createElement('figure');
      fig.className = 'cover';
      const cap = document.createElement('figcaption');
      cap.textContent = title;
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = t('coverDownload');
      b.addEventListener('click', () => canvas.toBlob(async (blob) => {
        if (blob) await download(new Uint8Array(await blob.arrayBuffer()), title.replace(/[^\w\- ]+/g, '') + '.png');
      }, 'image/png'));
      fig.append(canvas, cap, b);
      box.appendChild(fig);
    }
  }

  // ---------------------------------------------------------------------------
  // registry.txt (gráficos)
  // ---------------------------------------------------------------------------
  function loadRegistry(entries) {
    const idx = entries.findIndex((e) => !e.dir && /(^|\/)registry\.txt$/i.test(e.name));
    if (idx < 0) { state.registry = null; $('#registryCard').hidden = true; return; }
    const text = new TextDecoder().decode(entries[idx].data);
    state.registry = { index: idx, text, doc: S.parseRegistry(text) };
    $('#registryCard').hidden = false;
  }

  const regLabel = (key) => { const l = t('reg_' + key); return l === 'reg_' + key ? key : l; };
  const regValueText = (e, v) => (e.toggle ? (v === '1' ? t('valOn') : t('valOff')) : v);

  function renderRegistry() {
    const box = $('#registryList');
    if (!state.registry) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    for (const e of state.registry.doc.entries.filter((x) => !x.hidden)) {
      const changed = e.value !== e.originalValue;
      const row = document.createElement('div');
      row.className = 'set-row' + (changed ? ' changed' : '');
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = regLabel(e.key);
      const k = document.createElement('div');
      k.className = 'k';
      k.textContent = e.key;
      info.append(name, k);

      let control;
      if (e.toggle) {
        control = document.createElement('select');
        for (const [v, label] of [['1', t('valOn')], ['0', t('valOff')]]) {
          const o = document.createElement('option'); o.value = v; o.textContent = label; control.appendChild(o);
        }
      } else {
        control = document.createElement('input');
        control.type = 'number'; control.min = '0'; control.step = '1';
      }
      control.value = e.value;
      control.setAttribute('aria-label', regLabel(e.key));
      control.addEventListener('change', () => {
        try { S.setRegistry(state.registry.doc, e.key, control.value); }
        catch (err) { toast(errText(err), true); control.value = e.value; return; }
        renderRegistry(); renderChanges();
      });

      const reset = document.createElement('button');
      reset.className = 'small';
      reset.textContent = t('setReset');
      reset.disabled = !changed;
      reset.addEventListener('click', () => { S.resetRegistry(state.registry.doc, e.key); renderRegistry(); renderChanges(); });
      row.append(info, control, reset);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Historial de respaldos
  // ---------------------------------------------------------------------------
  const H = window.NFSU2History;

  /** Resumen de la primera partida de un zip o archivo, para mostrarlo en el historial. */
  async function quickSummary(bytes) {
    try {
      let save = bytes;
      if (C.isZip(bytes)) save = (await C.readZip(bytes)).find((e) => !e.dir && C.isSave(e.data))?.data;
      if (!save || !C.isSave(save)) return null;
      const s = C.readSummary(save);
      return { profile: s.name, money: s.money, cars: s.usedSlots };
    } catch (_) { return null; }
  }

  async function recordHistory(name, kind, bytes) {
    const sum = await quickSummary(bytes);
    await H.add({ name, kind, bytes: bytes.slice(), ...(sum || {}) }, C.crc32);
    renderHistory();
  }

  async function renderHistory() {
    const box = $('#historyList');
    $('#historyDetails').querySelector('p').textContent = t('histIntro', { max: H.MAX_ITEMS });
    if (!(await H.available())) { box.innerHTML = `<p class="muted">${t('histUnavailable')}</p>`; $('#histClear').hidden = true; return; }
    const items = await H.list();
    $('#histClear').hidden = !items.length;
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = `<p class="muted">${t('histEmpty')}</p>`; return; }
    const dateFmt = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 't';
      title.textContent = it.name;
      const badge = document.createElement('span');
      badge.className = 'badge' + (it.kind === 'edited' ? ' ed' : '');
      badge.textContent = it.kind === 'edited' ? t('histEdited') : t('histOpened');
      title.appendChild(badge);
      const meta = document.createElement('div');
      meta.className = 'm';
      meta.textContent = dateFmt.format(new Date(it.savedAt)) + ' · ' + t('histMeta', {
        profile: it.profile ?? '—', money: fmt(it.money ?? 0), cars: it.cars ?? '—', size: fmt(Math.ceil(it.bytes.length / 1024)),
      });
      info.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'row';
      const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.addEventListener('click', fn); return b; };
      actions.append(
        mk(t('histOpen'), () => { openBytes(it.bytes.slice(), it.name); window.scrollTo({ top: 0, behavior: 'smooth' }); }),
        mk(t('histUseA'), () => useHistoryInCompare('A', it)),
        mk(t('histUseB'), () => useHistoryInCompare('B', it)),
        mk(t('histDownload'), () => download(it.bytes, it.name)),
        mk(t('histDelete'), async () => { await H.remove(it.id); renderHistory(); }),
      );
      row.append(info, actions);
      box.appendChild(row);
    }
  }

  async function useHistoryInCompare(side, it) {
    $('#compareDetails').open = true;
    await loadCompareBytes(side, it.bytes, it.name);
    $('#compareDetails').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Doble clic para confirmar (los diálogos confirm() no funcionan en todas partes)
  let clearArmed = null;
  $('#histClear').addEventListener('click', async () => {
    const b = $('#histClear');
    if (!clearArmed) {
      b.textContent = t('histConfirmBtn');
      b.classList.add('danger');
      $('#histConfirmMsg').textContent = t('histConfirm');
      clearArmed = setTimeout(disarmClear, 5000);
      return;
    }
    disarmClear();
    await H.clear();
    renderHistory();
  });
  function disarmClear() {
    clearTimeout(clearArmed); clearArmed = null;
    $('#histClear').textContent = t('histClear');
    $('#histClear').classList.remove('danger');
    $('#histConfirmMsg').textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Notas del comparador (se guardan en este navegador)
  // ---------------------------------------------------------------------------
  const NOTES_KEY = 'nfsu2-zone-notes';
  let notes = {};
  try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}') || {}; } catch (_) { notes = {}; }
  const noteKey = (off) => '0x' + off.toString(16).toUpperCase();
  function saveNotes() { try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (_) { /* sin almacenamiento */ } }
  function setNote(off, text) {
    const v = text.trim();
    if (v) notes[noteKey(off)] = v; else delete notes[noteKey(off)];
    saveNotes();
  }

  $('#notesExport').addEventListener('click', () => {
    const data = { app: 'nfsu2-save-editor', version: 1, notes };
    download(new TextEncoder().encode(JSON.stringify(data, null, 2)), `nfsu2-notas-${stamp()}.json`);
  });
  $('#notesImport').addEventListener('click', () => $('#notesFile').click());
  $('#notesFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = data && typeof data.notes === 'object' ? data.notes : null;
      if (!incoming) throw new Error('bad');
      let n = 0;
      for (const [k, v] of Object.entries(incoming)) {
        if (/^0x[0-9A-F]+$/i.test(k) && typeof v === 'string' && v.trim()) { notes['0x' + k.slice(2).toUpperCase()] = v.trim().slice(0, 200); n++; }
      }
      saveNotes();
      renderCompare();
      toast(t('notesImported', { n }));
    } catch (_) { toast(t('notesBad'), true); }
  });

  // ---------------------------------------------------------------------------
  // Comparador
  // ---------------------------------------------------------------------------
  const cmp = { A: null, B: null, side: 'A', result: null };

  async function savesFromBytes(bytes, fileName) {
    const file = { name: fileName };
    if (C.isZip(bytes)) {
      const entries = await C.readZip(bytes);
      const saves = entries.filter((e) => !e.dir && C.isSave(e.data));
      if (!saves.length) throw Object.assign(new Error(), { ui: 'noSaveInZip' });
      return saves.map((e) => ({ label: `${file.name} › ${e.name}`, entry: e.name, bytes: e.data }));
    }
    if (!C.isSave(bytes)) throw Object.assign(new Error(), { ui: 'notASave' });
    return [{ label: file.name, entry: file.name, bytes }];
  }

  async function loadCompare(side, file) {
    return loadCompareBytes(side, new Uint8Array(await file.arrayBuffer()), file.name);
  }

  async function loadCompareBytes(side, bytes, fileName) {
    $('#cmpErr').textContent = '';
    try {
      const saves = await savesFromBytes(bytes, fileName);
      const other = cmp[side === 'A' ? 'B' : 'A'];
      // si el zip trae varias, usar la que se llame igual que la del otro lado
      const pick = (other && saves.find((s) => s.entry === other.entry)) || saves[0];
      setCompare(side, pick);
    } catch (e) {
      $('#cmpErr').textContent = e.ui ? t(e.ui) : t('zipBad');
    }
  }

  function setCompare(side, save) {
    cmp[side] = save;
    const s = C.readSummary(save.bytes);
    $('#cmpInfo' + side).textContent = `${save.label} — ${s.name} · $ ${fmt(s.money)} · ${s.usedSlots}/${C.LAYOUT.NUM_SLOTS}`;
    runCompare();
  }

  function runCompare() {
    if (!cmp.A || !cmp.B) { $('#cmpResult').hidden = true; return; }
    cmp.result = C.compareSaves(cmp.A.bytes, cmp.B.bytes);
    renderCompare();
  }

  const hexBytes = (u8, max = 16) => {
    const parts = [...u8.subarray(0, max)].map((b) => b.toString(16).toUpperCase().padStart(2, '0'));
    return parts.join(' ') + (u8.length > max ? ' …' : '');
  };

  function zoneLabel(z) { return t(z.key, { n: z.n, rel: z.rel != null ? '0x' + z.rel.toString(16).toUpperCase() : '' }); }

  function valueText(r) {
    if (r.zone.key === 'zoneMoney') return `${fmt(C.readMoney(cmp.A.bytes))} → ${fmt(C.readMoney(cmp.B.bytes))}`;
    if (r.zone.key === 'zoneName') return `${C.readName(cmp.A.bytes)} → ${C.readName(cmp.B.bytes)}`;
    if (r.numBefore != null) return `${fmt(r.numBefore)} → ${fmt(r.numAfter)}`;
    return '';
  }

  function visibleRegions() {
    const hideKnown = $('#cmpHideKnown').checked;
    const hideCheck = $('#cmpHideChecksum').checked;
    return cmp.result.regions.filter((r) => {
      if (hideCheck && (r.zone.key === 'zoneChecksum' || r.zone.key === 'zoneHeader')) return false;
      if (hideKnown && r.zone.key !== 'zoneUnknown') return false;
      return true;
    });
  }

  function renderCompare() {
    if (!cmp.result) return;
    const res = cmp.result;
    $('#cmpResult').hidden = false;
    $('#cmpSummary').textContent = res.regions.length ? t('cmpSummary', { n: fmt(res.bytes), r: fmt(res.regions.length) }) : t('cmpSame');
    $('#cmpSizeWarn').hidden = res.sizeA === res.sizeB;
    $('#cmpSizeWarn').textContent = t('cmpSize', { a: fmt(res.sizeA), b: fmt(res.sizeB) });
    const rows = visibleRegions();
    const LIMIT = 500;
    const table = $('#cmpTable');
    table.innerHTML = '';
    const head = document.createElement('tr');
    for (const k of ['colOffset', 'colZone', 'colLen', 'colBefore', 'colAfter', 'colValue', 'colNote']) {
      const th = document.createElement('th'); th.textContent = t(k); head.appendChild(th);
    }
    table.appendChild(head);
    for (const r of rows.slice(0, LIMIT)) {
      const tr = document.createElement('tr');
      if (r.zone.key === 'zoneUnknown') tr.className = 'unknown';
      const cells = [
        ['mono', '0x' + r.start.toString(16).toUpperCase().padStart(5, '0')],
        ['zone', notes[noteKey(r.start)] ? `${notes[noteKey(r.start)]} · ${zoneLabel(r.zone)}` : zoneLabel(r.zone)],
        ['', String(r.length)],
        ['mono', hexBytes(r.before)],
        ['mono after', hexBytes(r.after)],
        ['', valueText(r)],
      ];
      for (const [cls, txt] of cells) {
        const td = document.createElement('td');
        if (cls.includes('mono')) td.className = 'mono';
        if (cls === 'zone' && notes[noteKey(r.start)]) {
          const b = document.createElement('span'); b.className = 'noted'; b.textContent = notes[noteKey(r.start)];
          td.append(b, document.createTextNode(' · ' + zoneLabel(r.zone)));
        } else if (cls.includes('after')) { const sp = document.createElement('span'); sp.className = 'after'; sp.textContent = txt; td.appendChild(sp); }
        else td.textContent = txt;
        tr.appendChild(td);
      }
      const noteTd = document.createElement('td');
      noteTd.className = 'note-cell';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.value = notes[noteKey(r.start)] || '';
      input.setAttribute('aria-label', t('colNote') + ' ' + noteKey(r.start));
      input.addEventListener('change', () => { setNote(r.start, input.value); renderCompare(); });
      noteTd.appendChild(input);
      tr.appendChild(noteTd);
      table.appendChild(tr);
    }
    $('#cmpShowing').textContent = t('cmpShowing', { n: fmt(Math.min(rows.length, LIMIT)), total: fmt(res.regions.length) });
  }

  function exportCsv() {
    if (!cmp.result) return;
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['offset', 'zone', 'bytes', 'before', 'after', 'value', 'note'].join(',')];
    for (const r of visibleRegions()) {
      lines.push([q('0x' + r.start.toString(16).toUpperCase()), q(zoneLabel(r.zone)), r.length, q(hexBytes(r.before, 9999)), q(hexBytes(r.after, 9999)), q(valueText(r)), q(notes[noteKey(r.start)] || '')].join(','));
    }
    download(new TextEncoder().encode('﻿' + lines.join('\r\n')), `nfsu2-comparacion-${stamp()}.csv`);
  }

  function updateUseButtons() {
    document.querySelectorAll('[data-use]').forEach((b) => { b.disabled = !state.work; });
  }

  document.querySelectorAll('.small-drop').forEach((d) => {
    const side = d.dataset.side;
    d.addEventListener('click', () => { cmp.side = side; $('#cmpFile').click(); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cmp.side = side; $('#cmpFile').click(); } });
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', (e) => {
      e.preventDefault(); d.classList.remove('over');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadCompare(side, f);
    });
  });
  $('#cmpFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadCompare(cmp.side, f);
    e.target.value = '';
  });
  document.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
    if (!state.work) return;
    const src = state.source;
    const entry = src.kind === 'zip' ? src.entries[src.entryIndex].name : src.name;
    setCompare(b.dataset.use, { label: t('useCurrent'), entry, bytes: state.work.slice() });
  }));
  $('#cmpHideKnown').addEventListener('change', renderCompare);
  $('#cmpHideChecksum').addEventListener('change', renderCompare);
  $('#cmpExport').addEventListener('click', exportCsv);

  // ---------------------------------------------------------------------------
  // Pintado
  // ---------------------------------------------------------------------------
  const perfLabel = (p) => t(p === 'stock' ? 'perfStock' : p === 'max' ? 'perfMax' : 'perfMixed');

  function render() {
    if (!state.work) return;
    const s = C.readSummary(state.work);

    $('#sName').textContent = s.name || '—';
    $('#sMoney').textContent = '$ ' + fmt(s.money);
    $('#sCars').textContent = `${s.usedSlots} / ${C.LAYOUT.NUM_SLOTS}`;
    const hOk = s.header.ok;
    $('#sHeader').textContent = hOk ? t('headerOk') : t('headerBad');
    $('#sHeader').className = 'v ' + (hOk ? 'ok' : 'warn');
    $('#headerWarn').hidden = hOk;

    $('#nameHint').textContent = t('nameHint', { max: C.LAYOUT.NAME_FIELD - 1 });
    $('#moneyHint').textContent = t('moneyHint', { max: fmt(C.MONEY_MAX) });
    document.querySelectorAll('[data-add]').forEach((b) => { b.textContent = '+' + fmt(b.dataset.add); });
    if (document.activeElement !== $('#name')) $('#name').value = s.name;
    if (document.activeElement !== $('#money')) $('#money').value = s.money;

    renderGarage(s);
    renderSettings();
    renderRegistry();
    renderChanges();
    renderHex();

    $('#download').textContent = state.source.kind === 'zip' ? t('downloadZip') : t('download');
    $('#undo').disabled = state.history.length === 0;
  }

  function renderGarage(s) {
    const box = $('#garage');
    box.innerHTML = '';
    const emptySlots = s.slots.filter((x) => !x.used && !x.locked).map((x) => x.index);
    for (const slot of s.slots) {
      const div = document.createElement('div');
      div.className = 'slot' + (slot.used ? '' : ' empty') + (slot.locked ? ' locked' : '');
      const title = document.createElement('h3');
      title.textContent = t('slot', { n: slot.index + 1 });
      div.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = slot.used
        ? `${t('carId')}: ${slot.carIdHex} · ${t('perf')}: ${perfLabel(slot.perfState)}`
        : (slot.locked ? t('slotLocked') : t('slotAvailable'));
      div.appendChild(meta);

      if (slot.locked && !slot.used) {
        const row = document.createElement('div');
        row.className = 'row';
        row.append(btn(t('unlockSlot'), () => edit((u8) => C.unlockSlot(u8, slot.index)), false, true));
        div.appendChild(row);
      }

      if (slot.used) {
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
          btn(t('perfToMax'), () => edit((u8) => C.setPerformance(u8, slot.index, 'max')), slot.perfState === 'max'),
          btn(t('perfToStock'), () => edit((u8) => C.setPerformance(u8, slot.index, 'stock')), slot.perfState === 'stock'),
          btn(t('duplicate'), () => {
            if (!emptySlots.length) return toast(t('noEmptySlot'), true);
            edit((u8) => C.duplicateSlot(u8, slot.index, emptySlots[0]));
          }, !emptySlots.length, true),
        );
        div.appendChild(row);
      }
      if (slotChanged(slot.index)) {
        const r = btn(t('restore'), () => edit((u8) => C.restoreSlot(u8, state.original, slot.index)));
        r.style.marginTop = '8px';
        div.appendChild(r);
      }
      box.appendChild(div);
    }
  }

  function btn(label, onClick, disabled, experimental) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = label;
    if (experimental) {
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = t('experimental');
      b.appendChild(tag);
    }
    b.disabled = !!disabled;
    b.addEventListener('click', () => { try { onClick(); } catch (e) { toast(errText(e), true); } });
    return b;
  }

  function slotChanged(i) {
    const base = C.LAYOUT.SLOTS_OFF + i * C.LAYOUT.SLOT_SIZE;
    for (let k = 0; k < C.LAYOUT.SLOT_SIZE; k++) if (state.work[base + k] !== state.original[base + k]) return true;
    return false;
  }

  function renderChanges() {
    const { changes, bytes } = C.diff(state.original, state.work);
    const setChanges = state.settings ? S.changed(state.settings.doc) : [];
    const regChanges = state.registry ? S.changedRegistry(state.registry.doc) : [];
    const box = $('#changes');
    box.innerHTML = '';
    if (!changes.length && !bytes && !setChanges.length && !regChanges.length) {
      box.innerHTML = `<p class="muted" style="margin:0">${t('noChanges')}</p>`;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'changes';
    for (const c of changes) {
      const li = document.createElement('li');
      if (c.field === 'name') li.textContent = t('chName', { from: c.from, to: c.to });
      else if (c.field === 'money') li.textContent = t('chMoney', { from: fmt(c.from), to: fmt(c.to) });
      else if (c.field === 'unlock') li.textContent = t('chUnlock', { n: c.slot + 1 });
      else if (c.field === 'perf') li.textContent = t('chPerf', { n: c.slot + 1, from: perfLabel(c.from), to: perfLabel(c.to) });
      else if (!c.from.used && c.to.used) li.textContent = t('chSlotAdd', { n: c.slot + 1, id: c.to.carIdHex });
      else li.textContent = t('chSlotOther', { n: c.slot + 1 });
      ul.appendChild(li);
    }
    for (const o of setChanges) {
      const li = document.createElement('li');
      const from = o.originalActive ? o.originalValue : `${o.originalValue || '—'} ${t('valDefault')}`;
      const to = o.active ? o.value : `${o.value || '—'} ${t('valDefault')}`;
      li.textContent = t('chSetting', { key: optLabel(o.key), from, to });
      ul.appendChild(li);
    }
    for (const e of regChanges) {
      const li = document.createElement('li');
      li.textContent = t('chRegistry', { key: regLabel(e.key), from: regValueText(e, e.originalValue), to: regValueText(e, e.value) });
      ul.appendChild(li);
    }
    box.appendChild(ul);
    const p = document.createElement('p');
    p.className = 'muted'; p.style.margin = '8px 0 0';
    p.textContent = t('bytesChanged', { n: fmt(bytes) });
    if (bytes) box.appendChild(p);
  }

  function renderHex() {
    const lines = C.hexDump(state.work, state.hexOffset, 128, state.original);
    const box = $('#hex');
    box.innerHTML = '';
    for (const line of lines) {
      const div = document.createElement('div');
      const off = document.createElement('span');
      off.className = 'off';
      off.textContent = line.offset.toString(16).toUpperCase().padStart(6, '0') + '  ';
      div.appendChild(off);
      line.cells.forEach((c, i) => {
        const sp = document.createElement('span');
        sp.textContent = c.value.toString(16).toUpperCase().padStart(2, '0');
        if (c.changed) sp.className = 'chg';
        div.appendChild(sp);
        div.appendChild(document.createTextNode(i === 7 ? '  ' : ' '));
      });
      const asc = document.createElement('span');
      asc.className = 'asc';
      asc.textContent = ' ' + line.ascii;
      div.appendChild(asc);
      box.appendChild(div);
    }
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  const drop = $('#drop');
  drop.addEventListener('click', () => $('#file').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';
  });
  $('#zipSelect').addEventListener('change', (e) => loadSave(Number(e.target.value)));

  $('#name').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    $('#nameErr').textContent = '';
    if (v === C.readName(state.work)) return;
    try { C.validateName(v); edit((u8) => C.writeName(u8, v)); }
    catch (err) { $('#nameErr').textContent = errText(err); }
  });

  function setMoney(value) {
    $('#moneyErr').textContent = '';
    try {
      C.validateMoney(value);
      if (value !== C.readMoney(state.work)) edit((u8) => C.writeMoney(u8, value));
    } catch (err) { $('#moneyErr').textContent = errText(err); }
  }
  $('#moneySet').addEventListener('click', () => setMoney(Number($('#money').value)));
  $('#money').addEventListener('keydown', (e) => { if (e.key === 'Enter') setMoney(Number(e.target.value)); });
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    setMoney(Math.min(C.MONEY_MAX, C.readMoney(state.work) + Number(b.dataset.add)));
  }));

  $('#undo').addEventListener('click', () => {
    if (!state.history.length) return;
    state.work = state.history.pop();
    render();
  });
  $('#resetAll').addEventListener('click', () => {
    state.history.push(state.work.slice());
    state.work = state.original.slice();
    if (state.settings) state.settings.doc = S.parse(state.settings.text);
    if (state.registry) state.registry.doc = S.parseRegistry(state.registry.text);
    render();
  });

  $('#download').addEventListener('click', async () => {
    const src = state.source;
    if (src.kind === 'zip') {
      const entries = src.entries.map((e, i) => {
        if (i === src.entryIndex) return { ...e, data: state.work };
        if (state.settings && i === state.settings.index && S.changed(state.settings.doc).length) {
          return { ...e, data: new TextEncoder().encode(S.serialize(state.settings.doc)) };
        }
        if (state.registry && i === state.registry.index && S.changedRegistry(state.registry.doc).length) {
          return { ...e, data: new TextEncoder().encode(S.serializeRegistry(state.registry.doc)) };
        }
        return e;
      });
      const base = src.name.replace(/\.zip$/i, '').replace(/-editado-[\d_-]+$/, '');
      const outName = `${base}-editado-${stamp()}.zip`;
      const out = C.writeZip(entries);
      recordHistory(outName, 'edited', out);
      if (!(await download(out, outName))) return;
    } else {
      recordHistory(src.name, 'edited', state.work.slice());
      if (!(await download(state.work, src.name))) return;
    }
    if ($('#autoBackup').checked) await downloadOriginal();
    toast(t('done'));
  });

  function downloadOriginal() {
    const src = state.source;
    if (src.kind === 'zip') return download(src.rawBytes, src.name.replace(/\.zip$/i, '') + '-original.zip');
    return download(src.rawBytes, src.name + '.bak');
  }
  $('#downloadOriginal').addEventListener('click', downloadOriginal);

  function goHex(off) {
    const n = parseInt(String(off).replace(/^0x/i, ''), 16);
    if (Number.isNaN(n) || !state.work) return;
    state.hexOffset = Math.max(0, Math.min(state.work.length - 1, n));
    $('#hexOff').value = state.hexOffset.toString(16).toUpperCase();
    renderHex();
  }
  $('#hexGo').addEventListener('click', () => goHex($('#hexOff').value));
  $('#hexOff').addEventListener('keydown', (e) => { if (e.key === 'Enter') goHex(e.target.value); });
  document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => goHex(b.dataset.jump)));

  // Idioma
  const langSel = $('#lang');
  for (const [code, strings] of Object.entries(window.I18N.STRINGS)) {
    const o = document.createElement('option');
    o.value = code; o.textContent = strings.langName;
    langSel.appendChild(o);
  }
  function applyLang(code) {
    window.I18N.setLang(code);
    langSel.value = code;
    if (state.source) {
      $('#fileInfo').textContent = state.source.kind === 'zip'
        ? t('loadedZip', { name: state.source.name, count: state.source.entries.filter((e) => !e.dir).length })
        : t('loadedFile', { name: state.source.name, size: fmt(state.source.rawBytes.length) });
    }
    $('#setSearch').placeholder = t('setSearch');
    render();
    renderCompare();
    renderHistory();
    for (const side of ['A', 'B']) if (cmp[side]) setCompare(side, cmp[side]);
  }
  langSel.addEventListener('change', (e) => applyLang(e.target.value));
  applyLang(window.I18N.detect());
})();
