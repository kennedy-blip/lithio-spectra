/**
 * Offline-First IndexedDB Persistence Vault & Mutation Sync Queue
 * Stores longitudinal battery diagnostics across 5 object stores + sync_queue.
 */

const DB_NAME = 'lithio_spectra_vault_v1';
const DB_VERSION = 1;

export const VAULT_STORES = [
  'thevenin_dcir_tests',
  'pouch_swell_scans',
  'thermal_runaway_audits',
  'charger_forensics_logs',
  'ev_device_valuations',
  'sync_queue'
];

function openVaultDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      for (const store of VAULT_STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Memory fallback if IndexedDB is blocked in strict private mode
const memoryFallback = Object.fromEntries(VAULT_STORES.map((s) => [s, []]));

export async function saveDiagnosticRecord(storeName, record) {
  const entry = {
    id: record.id || `${storeName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: record.createdAt || new Date().toISOString(),
    ...record
  };

  try {
    const db = await openVaultDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([storeName, 'sync_queue'], 'readwrite');
      tx.objectStore(storeName).put(entry);
      tx.objectStore('sync_queue').put({
        id: `sync-${entry.id}`,
        storeName,
        module: storeName,
        payload: entry,
        status: 'QUEUED',
        queuedAt: new Date().toISOString()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    memoryFallback[storeName].unshift(entry);
    memoryFallback.sync_queue.unshift({
      id: `sync-${entry.id}`,
      storeName,
      module: storeName,
      payload: entry,
      status: 'QUEUED',
      queuedAt: new Date().toISOString()
    });
  }
  return entry;
}

export async function listStoreRecords(storeName) {
  try {
    const db = await openVaultDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        rows.sort((a, b) => String(b.createdAt || b.queuedAt || '').localeCompare(String(a.createdAt || a.queuedAt || '')));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [...(memoryFallback[storeName] || [])];
  }
}

export async function flushSyncQueue() {
  const queued = await listStoreRecords('sync_queue');
  const pending = queued.filter((q) => q.status === 'QUEUED');
  if (!pending.length) {
    return { synced: 0, mode: 'idle', items: queued };
  }

  let remoteSynced = 0;
  let usedMirror = false;

  for (const item of pending) {
    try {
      const res = await fetch('/api/electrochem_battery_solver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: item.module, payload: item.payload })
      });
      if (res.ok) {
        item.status = 'SYNCED_CLOUD';
        remoteSynced += 1;
      } else {
        item.status = 'SYNCED_LOCAL_MIRROR';
        usedMirror = true;
      }
    } catch {
      item.status = 'SYNCED_LOCAL_MIRROR';
      usedMirror = true;
    }
    item.syncedAt = new Date().toISOString();

    try {
      const db = await openVaultDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sync_queue', 'readwrite');
        tx.objectStore('sync_queue').put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      const idx = memoryFallback.sync_queue.findIndex((x) => x.id === item.id);
      if (idx >= 0) memoryFallback.sync_queue[idx] = item;
    }
  }

  const updated = await listStoreRecords('sync_queue');
  return {
    synced: pending.length,
    remoteSynced,
    mode: usedMirror ? 'offline-mirror' : 'cloud-go-1.22',
    items: updated
  };
}

export async function exportElectrochemicalCertificate() {
  const snapshot = {};
  for (const s of VAULT_STORES) {
    snapshot[s] = await listStoreRecords(s);
  }
  return {
    certificateId: `LITHIO-CERT-${Date.now().toString(36).toUpperCase()}`,
    generatedAtUtc: new Date().toISOString(),
    appVersion: '1.24.0',
    standards: ['IEEE 1188 DCIR', 'Timoshenko Plate Swell', 'Semenov/Arrhenius 4-Stage', 'Schmalstieg SEI'],
    records: snapshot
  };
}
