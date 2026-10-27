/*
 * Historial de respaldos guardado en el navegador (IndexedDB).
 * Solo vive en este navegador y en este equipo: no reemplaza los zips de tu carpeta de Descargas.
 * Si el navegador no permite guardar (modo privado, almacenamiento bloqueado), todo sigue
 * funcionando y el historial simplemente queda vacío.
 */
(function (root) {
  const DB_NAME = 'nfsu2-editor';
  const STORE = 'backups';
  const MAX_ITEMS = 40;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve) => {
      try {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const result = fn(store);
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : true);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  async function list() {
    const db = await open();
    if (!db) return [];
    const all = (await tx(db, 'readonly', (s) => s.getAll())) || [];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Guarda un archivo (zip o partida). Si ya existe uno idéntico (mismo CRC y tamaño), solo
   * actualiza su fecha. item: { name, kind: 'opened'|'edited', bytes, profile, money, cars }
   */
  async function add(item, crc32) {
    const db = await open();
    if (!db) return false;
    const id = `${crc32(item.bytes).toString(16)}-${item.bytes.length}`;
    const existing = await tx(db, 'readonly', (s) => s.get(id));
    const record = { ...(existing || {}), ...item, id, savedAt: Date.now(), bytes: item.bytes };
    if (existing && existing.kind === 'edited') record.kind = 'edited';
    const ok = await tx(db, 'readwrite', (s) => s.put(record));
    // recortar a los más recientes
    const all = await list();
    for (const old of all.slice(MAX_ITEMS)) await remove(old.id);
    return !!ok;
  }

  async function get(id) {
    const db = await open();
    return db ? tx(db, 'readonly', (s) => s.get(id)) : null;
  }

  async function remove(id) {
    const db = await open();
    return db ? tx(db, 'readwrite', (s) => s.delete(id)) : null;
  }

  async function clear() {
    const db = await open();
    return db ? tx(db, 'readwrite', (s) => s.clear()) : null;
  }

  async function available() { return !!(await open()); }

  root.NFSU2History = { list, add, get, remove, clear, available, MAX_ITEMS };
})(self);
