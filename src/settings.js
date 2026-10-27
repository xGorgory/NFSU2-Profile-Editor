/*
 * Lectura y escritura de settings.ini de nfsu2.xyz (Underground 2 Revived).
 * Conserva todos los comentarios: solo cambia las líneas de las opciones que se editan.
 * Una opción comentada ("#clave = valor") usa el valor por defecto del juego.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NFSU2Settings = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ON_OFF = ['on', 'off'];

  /** Valores posibles conocidos (sacados de las descripciones del archivo). */
  const CHOICES = {
    intro: ['skippable', 'original', 'off'],
    language: ['english', 'french', 'german', 'italian', 'spanish', 'dutch', 'swedish', 'danish', 'korean', 'chinese', 'japanese', 'russian', 'thai', 'portuguese', 'polish', 'turkish'],
    background: ['pause', 'run'],
    hud: ['wide', '43'],
    movie_framing: ['fit', 'fill', 'stretch'],
    cutscene_borders: ['full', 'off'],
    other_headlights: ['players', 'all', 'off'],
    ui_textures: ['original', 'uhud'],
    fps: ['auto', '30', '60', '120', '240', 'uncapped', 'off'],
    fps_counter: ['off', 'on', 'detailed'],
    audio_latency: ['interactive', 'balanced', 'playback'],
    gamepad: ['on', 'hotplug', 'off'],
    horn: ['dual', 'single', 'truck', 'train', 'klaxon', 'cucaracha', 'clown', 'trombone'],
    render: ['backing', 'scale:0.5', 'scale:0.75', 'scale:1', 'scale:1.25', 'scale:1.5', 'scale:2'],
  };

  const OPT_COMMENTED = /^#([a-z][a-z0-9_]*) = ?(.*)$/;
  const OPT_ACTIVE = /^([a-z][a-z0-9_]*)\s*=\s*(.*)$/;
  const SECTION = /^#\s*-{3,}\s*(.+?)\s*-{3,}\s*$/;

  function parse(text) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const options = [];
    let section = '';
    let comment = [];
    lines.forEach((line, i) => {
      const sec = line.match(SECTION);
      if (sec) { section = sec[1]; comment = []; return; }
      const c = line.match(OPT_COMMENTED);
      const a = !c && line.match(OPT_ACTIVE);
      const m = c || a;
      if (m) {
        const key = m[1];
        const value = m[2].trim();
        options.push({
          key, line: i, section,
          description: comment.join(' ').replace(/\s+/g, ' ').trim(),
          active: !!a,
          originalActive: !!a,
          value,
          originalValue: value,
          // si venía comentada, el valor mostrado es el predeterminado del juego
          defaultValue: c ? value : null,
          choices: CHOICES[key] || (ON_OFF.includes(value) ? ON_OFF : null),
        });
        comment = [];
        return;
      }
      if (line.startsWith('#')) {
        comment.push(line.replace(/^#\s?/, ''));
      } else if (line.trim() === '') {
        comment = [];
      }
    });
    // compartir la descripción con opciones seguidas sin comentario propio
    for (let k = 1; k < options.length; k++) {
      if (!options[k].description && options[k - 1].line === options[k].line - 1) options[k].description = options[k - 1].description;
    }
    return { lines, eol, options, sections: [...new Set(options.map((o) => o.section))] };
  }

  /** Cambia el valor; si coincide con el predeterminado, la línea vuelve a quedar comentada. */
  function setValue(doc, key, value) {
    const opt = doc.options.find((o) => o.key === key);
    if (!opt) throw new Error('Unknown option ' + key);
    opt.value = String(value).trim();
    opt.active = !(opt.defaultValue !== null && opt.value === opt.defaultValue);
  }

  function resetValue(doc, key) {
    const opt = doc.options.find((o) => o.key === key);
    if (!opt) return;
    if (opt.defaultValue !== null) { opt.value = opt.defaultValue; opt.active = false; }
    else { opt.value = opt.originalValue; opt.active = opt.originalActive; }
  }

  function changed(doc) {
    return doc.options.filter((o) => o.value !== o.originalValue || o.active !== o.originalActive);
  }

  function serialize(doc) {
    const lines = doc.lines.slice();
    for (const o of doc.options) {
      if (o.value === o.originalValue && o.active === o.originalActive) continue;
      lines[o.line] = (o.active ? '' : '#') + o.key + ' = ' + o.value;
    }
    return lines.join(doc.eol);
  }

  // ---------------------------------------------------------------------------
  // registry.txt (gráficos del juego): líneas "d clave=valor"
  // ---------------------------------------------------------------------------
  const REG_LINE = /^(\w)\s+([^=\s]+)=(.*)$/;
  /** Claves internas que no conviene tocar. */
  const REG_HIDDEN = new Set(['NotFirstTime', 'VERSION', 'SIZE']);

  function parseRegistry(text) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const entries = [];
    lines.forEach((line, i) => {
      const m = line.match(REG_LINE);
      if (!m) return;
      const value = m[3].trim();
      entries.push({
        type: m[1], key: m[2], line: i, value, originalValue: value,
        hidden: REG_HIDDEN.has(m[2]),
        // interruptor si el nombre termina en Enable/On y vale 0 o 1
        toggle: /(Enable|On)$/.test(m[2]) && (value === '0' || value === '1') && !/Shadow|Reflection|EnvironmentMap/.test(m[2]),
      });
    });
    return { lines, eol, entries };
  }

  function setRegistry(doc, key, value) {
    const e = doc.entries.find((x) => x.key === key);
    if (!e) throw new Error('Unknown key ' + key);
    const v = String(value).trim();
    if (!/^\d+$/.test(v)) throw Object.assign(new Error('REG_NUMBER'), { code: 'REG_NUMBER' });
    e.value = v;
  }

  function resetRegistry(doc, key) {
    const e = doc.entries.find((x) => x.key === key);
    if (e) e.value = e.originalValue;
  }

  const changedRegistry = (doc) => doc.entries.filter((e) => e.value !== e.originalValue);

  function serializeRegistry(doc) {
    const lines = doc.lines.slice();
    for (const e of doc.entries) if (e.value !== e.originalValue) lines[e.line] = `${e.type} ${e.key}=${e.value}`;
    return lines.join(doc.eol);
  }

  return {
    parse, setValue, resetValue, changed, serialize, CHOICES,
    parseRegistry, setRegistry, resetRegistry, changedRegistry, serializeRegistry,
  };
});
