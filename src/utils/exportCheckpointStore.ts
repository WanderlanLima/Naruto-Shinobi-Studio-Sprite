export interface ExportCheckpointJobMeta {
  jobId: string;
  ninjaId: string;
  ninjaName: string;
  optionsFingerprint: string;
  totalAnims: number;
  completedBase: boolean;
  completedEffects: boolean;
  completedMedia: boolean;
  completedAnims: string[];
  fileCount: number;
  updatedAt: number;
}

export interface ExportCheckpointFileRecord {
  key: string;
  jobId: string;
  path: string;
  data: Blob | ArrayBuffer | Uint8Array | string;
}

const CHECKPOINT_DB_NAME = 'shinobi_export_checkpoint_v1';
const CHECKPOINT_DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_FILES = 'files';

function openCheckpointDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CHECKPOINT_DB_NAME, CHECKPOINT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_JOBS)) {
          db.createObjectStore(STORE_JOBS, { keyPath: 'jobId' });
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          const filesStore = db.createObjectStore(STORE_FILES, { keyPath: 'key' });
          filesStore.createIndex('by_job', 'jobId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function buildExportOptionsFingerprint(opts: {
  effectScope: string;
  includeOriginalAndFrames: boolean;
  includeLinkedEffects: boolean;
  includeAnimPngsAndSheets: boolean;
  includeAnimGifs: boolean;
  includePassiveAura?: boolean;
  includeVideosAndAudio?: boolean;
  includeSkillIcons?: boolean;
  includeCharacterArtworks?: boolean;
  gifBg: string;
  fps?: number;
  maxResolution?: number;
}): string {
  return JSON.stringify([
    opts.effectScope,
    Boolean(opts.includeOriginalAndFrames),
    Boolean(opts.includeLinkedEffects),
    Boolean(opts.includeAnimPngsAndSheets),
    Boolean(opts.includeAnimGifs),
    opts.includePassiveAura !== false,
    opts.includeVideosAndAudio !== false,
    opts.includeSkillIcons !== false,
    opts.includeCharacterArtworks !== false,
    opts.gifBg,
    opts.fps ?? 24,
    opts.maxResolution ?? 2048,
  ]);
}

export function buildExportJobId(ninjaId: string, optionsFingerprint: string): string {
  let hash = 2166136261;
  for (let i = 0; i < optionsFingerprint.length; i++) {
    hash ^= optionsFingerprint.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${ninjaId}::${(hash >>> 0).toString(16)}`;
}

export async function getExportCheckpointByJobId(
  jobId: string
): Promise<ExportCheckpointJobMeta | null> {
  const db = await openCheckpointDb();
  if (!db) return null;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).get(jobId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as ExportCheckpointJobMeta | undefined) || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function getLatestExportCheckpoint(
  ninjaId?: string
): Promise<ExportCheckpointJobMeta | null> {
  const db = await openCheckpointDb();
  if (!db) return null;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).getAll();
      req.onsuccess = () => {
        db.close();
        const all = (req.result as ExportCheckpointJobMeta[] | undefined) || [];
        const filtered = ninjaId ? all.filter((j) => j.ninjaId === ninjaId) : all;
        filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(filtered[0] || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function saveExportCheckpointBatch(
  meta: ExportCheckpointJobMeta,
  newFiles: Array<{ path: string; data: Blob | ArrayBuffer | Uint8Array | string }>
): Promise<boolean> {
  const db = await openCheckpointDb();
  if (!db) return false;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_JOBS, STORE_FILES], 'readwrite');
      const jobsStore = tx.objectStore(STORE_JOBS);
      const filesStore = tx.objectStore(STORE_FILES);

      for (const f of newFiles) {
        const record: ExportCheckpointFileRecord = {
          key: `${meta.jobId}::${f.path}`,
          jobId: meta.jobId,
          path: f.path,
          data: f.data,
        };
        filesStore.put(record);
      }
      jobsStore.put({ ...meta, updatedAt: Date.now() });

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

export async function loadExportCheckpointFiles(
  jobId: string
): Promise<Array<{ path: string; data: Blob | ArrayBuffer | Uint8Array | string }>> {
  const db = await openCheckpointDb();
  if (!db) return [];
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const idx = tx.objectStore(STORE_FILES).index('by_job');
      const req = idx.getAll(IDBKeyRange.only(jobId));
      req.onsuccess = () => {
        db.close();
        const rows = (req.result as ExportCheckpointFileRecord[] | undefined) || [];
        resolve(rows.map((r) => ({ path: r.path, data: r.data })));
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

export async function clearExportCheckpoint(jobId?: string): Promise<void> {
  const db = await openCheckpointDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_JOBS, STORE_FILES], 'readwrite');
      const jobsStore = tx.objectStore(STORE_JOBS);
      const filesStore = tx.objectStore(STORE_FILES);

      if (!jobId) {
        jobsStore.clear();
        filesStore.clear();
      } else {
        jobsStore.delete(jobId);
        const idx = filesStore.index('by_job');
        const cursorReq = idx.openKeyCursor(IDBKeyRange.only(jobId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            filesStore.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
