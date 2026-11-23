import { useSyncExternalStore } from 'react';
import type { ExtractResponse, NinjaEntry, NinjaMediaProfile } from '../types/sprite';

export interface MountedZipInfo {
  id: string;
  fileName: string;
  fileSize: number;
  entryCount: number;
  moduleId?: string;
  label?: string;
  createdAt?: string;
  isStoreFastPath: boolean;
}

export interface OfflineCoverageStats {
  totalEntries: number;
  totalBytes: number;
  catalogNinjas: number;
  spineAtlases: number;
  spriteSheets: number;
  particleFiles: number;
  videosMp4: number;
  audiosMp3: number;
  nameArts: number;
}

export type DataSourceMode = 'online' | 'offline';

export interface SavedOfflineArchiveMeta {
  fileName: string;
  fileSize: number;
  entryCount: number;
  label?: string;
  savedAt: number;
}

export interface OfflineZipSnapshot {
  sourceMode: DataSourceMode;
  active: boolean;
  hasMountedArchives: boolean;
  strictOffline: boolean;
  generation: number;
  origin: string;
  archives: MountedZipInfo[];
  savedArchives: SavedOfflineArchiveMeta[];
  canOneClickReauthorize: boolean;
  needsReconnect: boolean;
  restoring: boolean;
  hasCatalog: boolean;
  catalog: ExtractResponse | null;
  stats: OfflineCoverageStats;
  lastError: string | null;
}

interface ZipEntryRef {
  file: File;
  path: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  nameByteLen: number;
  dataOffset: number;
  verifiedOffset: boolean;
}

interface BackupMetaJson {
  format?: string;
  createdAt?: string;
  origin?: string;
  moduleId?: string;
  label?: string;
  storeZeroExtra?: boolean;
}

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
const MAX_CD_ENTRIES = 250_000;
const MAX_BLOB_CACHE = 240;

const textDecoder = new TextDecoder('utf-8');

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  json: 'application/json',
  atlas: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

function guessMimeType(entryPath: string): string {
  const dot = entryPath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = entryPath.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function sanitizeZipPath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.includes('..') || /[\x00-\x1f]/.test(normalized)) return null;
  return normalized;
}

function readBigUint64Number(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 4294967296 + lo;
}

async function parseSingleZipIndex(file: File): Promise<{
  entries: ZipEntryRef[];
  comment: string;
  isStoreFastPath: boolean;
}> {
  if (file.size < 22) {
    throw new Error(`O arquivo "${file.name}" não é um ZIP válido (muito pequeno).`);
  }

  const tailLen = Math.min(file.size, 65557);
  const tailStart = file.size - tailLen;
  const tailBuf = await file.slice(tailStart, file.size).arrayBuffer();
  const tailBytes = new Uint8Array(tailBuf);
  const tailView = new DataView(tailBuf);

  // Locate EOCD signature 0x06054b50 from the end
  let eocdPos = -1;
  for (let i = tailBytes.length - 22; i >= 0; i--) {
    if (
      tailBytes[i] === 0x50 &&
      tailBytes[i + 1] === 0x4b &&
      tailBytes[i + 2] === 0x05 &&
      tailBytes[i + 3] === 0x06
    ) {
      const commentLen = tailView.getUint16(i + 20, true);
      if (i + 22 + commentLen <= tailBytes.length) {
        eocdPos = i;
        break;
      }
    }
  }

  if (eocdPos === -1) {
    throw new Error(`Não foi possível localizar o índice central (EOCD) em "${file.name}".`);
  }

  let totalEntries = tailView.getUint16(eocdPos + 10, true);
  let cdSize = tailView.getUint32(eocdPos + 12, true);
  let cdOffset = tailView.getUint32(eocdPos + 16, true);
  const commentLen = tailView.getUint16(eocdPos + 20, true);
  const comment =
    commentLen > 0
      ? textDecoder.decode(tailBytes.subarray(eocdPos + 22, eocdPos + 22 + commentLen))
      : '';

  // Check ZIP64 EOCD Locator immediately before EOCD
  if (
    eocdPos >= 20 &&
    tailView.getUint32(eocdPos - 20, true) === 0x07064b50
  ) {
    const zip64EocdOffset = readBigUint64Number(tailView, eocdPos - 12);
    if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= file.size) {
      const z64Buf = await file.slice(zip64EocdOffset, zip64EocdOffset + 56).arrayBuffer();
      const z64View = new DataView(z64Buf);
      if (z64View.getUint32(0, true) === 0x06064b50) {
        totalEntries = readBigUint64Number(z64View, 32);
        cdSize = readBigUint64Number(z64View, 40);
        cdOffset = readBigUint64Number(z64View, 48);
      }
    }
  }

  if (totalEntries > MAX_CD_ENTRIES) {
    throw new Error(`O ZIP "${file.name}" excede o limite de segurança de ${MAX_CD_ENTRIES} entradas.`);
  }
  if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > file.size) {
    throw new Error(`Índice central corrompido ou incompleto em "${file.name}".`);
  }

  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cdBytes = new Uint8Array(cdBuf);
  const cdView = new DataView(cdBuf);

  const hasFastPathComment = comment.includes('SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA');
  const entries: ZipEntryRef[] = [];
  let pos = 0;

  while (pos + 46 <= cdBytes.length && entries.length < totalEntries) {
    const sig = cdView.getUint32(pos, true);
    if (sig !== 0x02014b50) break;

    const compressionMethod = cdView.getUint16(pos + 10, true);
    let compressedSize = cdView.getUint32(pos + 20, true);
    let uncompressedSize = cdView.getUint32(pos + 24, true);
    const nameLen = cdView.getUint16(pos + 28, true);
    const extraLen = cdView.getUint16(pos + 30, true);
    const fileCommentLen = cdView.getUint16(pos + 32, true);
    let localHeaderOffset = cdView.getUint32(pos + 42, true);

    const nameStart = pos + 46;
    const extraStart = nameStart + nameLen;
    const nextPos = extraStart + extraLen + fileCommentLen;
    if (nextPos > cdBytes.length) break;

    // Parse ZIP64 extra field (0x0001) if needed
    if (
      uncompressedSize === MAX_U32 ||
      compressedSize === MAX_U32 ||
      localHeaderOffset === MAX_U32
    ) {
      let ePos = extraStart;
      const eEnd = extraStart + extraLen;
      while (ePos + 4 <= eEnd) {
        const headerId = cdView.getUint16(ePos, true);
        const dataLen = cdView.getUint16(ePos + 2, true);
        ePos += 4;
        if (headerId === 0x0001 && ePos + dataLen <= eEnd) {
          let p64 = ePos;
          if (uncompressedSize === MAX_U32 && p64 + 8 <= ePos + dataLen) {
            uncompressedSize = readBigUint64Number(cdView, p64);
            p64 += 8;
          }
          if (compressedSize === MAX_U32 && p64 + 8 <= ePos + dataLen) {
            compressedSize = readBigUint64Number(cdView, p64);
            p64 += 8;
          }
          if (localHeaderOffset === MAX_U32 && p64 + 8 <= ePos + dataLen) {
            localHeaderOffset = readBigUint64Number(cdView, p64);
          }
          break;
        }
        ePos += dataLen;
      }
    }

    const rawName = textDecoder.decode(cdBytes.subarray(nameStart, extraStart));
    const safePath = sanitizeZipPath(rawName);
    if (safePath) {
      const localZip64Extra = uncompressedSize >= MAX_U32 ? 20 : 0;
      entries.push({
        file,
        path: safePath,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        nameByteLen: nameLen,
        dataOffset: localHeaderOffset + 30 + nameLen + localZip64Extra,
        verifiedOffset: false,
      });
    }

    pos = nextPos;
  }

  // Verify fast-path zero-extra assumption so synchronous File.slice() works immediately for all STORE ZIPs
  // (covers browser/server ZIPs with SHINOBI_BACKUP_V1 comment as well as Python zipfile / PowerShell ZipArchive ZIP64s)
  let isStoreFastPath = false;
  const storeEntries = entries.filter((e) => e.compressionMethod === 0);
  if (storeEntries.length > 0) {
    const sampleIndices = Array.from(
      new Set([0, Math.floor(storeEntries.length / 2), storeEntries.length - 1])
    );
    let allSamplesZeroExtra = true;
    for (const idx of sampleIndices) {
      const sample = storeEntries[idx];
      if (!sample || sample.localHeaderOffset + 30 > file.size) {
        allSamplesZeroExtra = false;
        break;
      }
      const lhBuf = await file
        .slice(sample.localHeaderOffset, sample.localHeaderOffset + 30)
        .arrayBuffer();
      const lhView = new DataView(lhBuf);
      const expectedLocalExtra = sample.uncompressedSize >= MAX_U32 ? 20 : 0;
      if (
        lhView.getUint32(0, true) !== 0x04034b50 ||
        lhView.getUint16(26, true) !== sample.nameByteLen ||
        lhView.getUint16(28, true) !== expectedLocalExtra
      ) {
        allSamplesZeroExtra = false;
        break;
      }
    }

    if (allSamplesZeroExtra && (hasFastPathComment || storeEntries.length === entries.length)) {
      isStoreFastPath = true;
      for (const e of storeEntries) {
        e.verifiedOffset = true;
      }
    }
  }

  return { entries, comment, isStoreFastPath };
}

async function ensureEntryDataOffset(entry: ZipEntryRef): Promise<number> {
  if (entry.verifiedOffset) return entry.dataOffset;
  const lhBuf = await entry.file
    .slice(entry.localHeaderOffset, entry.localHeaderOffset + 30)
    .arrayBuffer();
  const lhView = new DataView(lhBuf);
  if (lhView.getUint32(0, true) !== 0x04034b50) {
    throw new Error(`Cabeçalho local inválido para "${entry.path}".`);
  }
  const localNameLen = lhView.getUint16(26, true);
  const localExtraLen = lhView.getUint16(28, true);
  entry.dataOffset = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;
  entry.verifiedOffset = true;
  return entry.dataOffset;
}

const MAX_DEFLATE_ENTRY_BYTES = 256 * 1024 * 1024;

async function readEntryBlobAsync(entry: ZipEntryRef): Promise<Blob> {
  const dataOffset = await ensureEntryDataOffset(entry);
  if (dataOffset < 0 || entry.compressedSize < 0 || dataOffset + entry.compressedSize > entry.file.size) {
    throw new Error(`Intervalo de bytes inválido para "${entry.path}" dentro do ZIP.`);
  }
  const mime = guessMimeType(entry.path);
  const rawSlice = entry.file.slice(dataOffset, dataOffset + entry.compressedSize, mime);

  if (entry.compressionMethod === 0) {
    return rawSlice;
  }

  if (entry.compressionMethod === 8) {
    if (entry.uncompressedSize > MAX_DEFLATE_ENTRY_BYTES) {
      throw new Error(`Entrada comprimida excede o limite de segurança em "${entry.path}".`);
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'Este ZIP usa compressão DEFLATE e seu navegador não suporta DecompressionStream. Use o formato de backup padrão (STORE).'
      );
    }
    const ds = new DecompressionStream('deflate-raw');
    const decompressedStream = rawSlice.stream().pipeThrough(ds);
    const resp = new Response(decompressedStream);
    const ab = await resp.arrayBuffer();
    return new Blob([ab], { type: mime });
  }

  throw new Error(`Método de compressão ZIP não suportado (${entry.compressionMethod}) em "${entry.path}".`);
}

// ---------- Persistence (localStorage + IndexedDB handles/blobs) ----------

const SOURCE_PREFS_STORAGE_KEY = 'shinobi_offline_source_prefs_v1';
const OFFLINE_IDB_NAME = 'shinobi_offline_source_db_v1';
const OFFLINE_IDB_STORE = 'persisted_source';
const OFFLINE_IDB_KEY = 'active';
const OFFLINE_IDB_CATALOG_KEY = 'cached_catalog';
const MAX_IDB_INLINE_FILE_BYTES = 250 * 1024 * 1024; // 250 MB safe limit for Android/Desktop blob cloning

interface PersistedSourcePrefs {
  sourceMode: DataSourceMode;
  strictOffline: boolean;
  savedArchives: SavedOfflineArchiveMeta[];
}

interface HandlePermissionApi {
  name?: string;
  getFile: () => Promise<File>;
  queryPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
}

type PersistedIdbRecord =
  | { kind: 'handles'; handles: HandlePermissionApi[]; savedAt: number }
  | { kind: 'files'; files: File[]; savedAt: number };

interface PersistedCatalogCache {
  catalog: ExtractResponse;
  origin: string;
  savedAt: number;
}

function loadPersistedPrefs(): PersistedSourcePrefs {
  try {
    const raw = localStorage.getItem(SOURCE_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSourcePrefs>;
      const savedArchives = Array.isArray(parsed.savedArchives)
        ? parsed.savedArchives.filter(
            (a): a is SavedOfflineArchiveMeta =>
              Boolean(a) &&
              typeof a.fileName === 'string' &&
              typeof a.fileSize === 'number' &&
              Number.isFinite(a.fileSize)
          )
        : [];
      return {
        sourceMode: parsed.sourceMode === 'offline' ? 'offline' : 'online',
        strictOffline: typeof parsed.strictOffline === 'boolean' ? parsed.strictOffline : true,
        savedArchives,
      };
    }
  } catch {
    // ignore storage errors
  }
  return { sourceMode: 'online', strictOffline: true, savedArchives: [] };
}

function savePersistedPrefs(prefs: PersistedSourcePrefs) {
  try {
    localStorage.setItem(SOURCE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota/private-mode errors
  }
}

function openOfflineSourceDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(OFFLINE_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_IDB_STORE)) {
          db.createObjectStore(OFFLINE_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readPersistedIdbRecord(): Promise<PersistedIdbRecord | null> {
  const db = await openOfflineSourceDb();
  if (!db) return null;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(OFFLINE_IDB_STORE, 'readonly');
      const req = tx.objectStore(OFFLINE_IDB_STORE).get(OFFLINE_IDB_KEY);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as PersistedIdbRecord | undefined) || null);
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

async function readPersistedCatalogCache(): Promise<PersistedCatalogCache | null> {
  const db = await openOfflineSourceDb();
  if (!db) return null;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(OFFLINE_IDB_STORE, 'readonly');
      const req = tx.objectStore(OFFLINE_IDB_STORE).get(OFFLINE_IDB_CATALOG_KEY);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as PersistedCatalogCache | undefined) || null);
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

async function writePersistedCatalogCache(cache: PersistedCatalogCache | null): Promise<boolean> {
  const db = await openOfflineSourceDb();
  if (!db) return false;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(OFFLINE_IDB_STORE, 'readwrite');
      const store = tx.objectStore(OFFLINE_IDB_STORE);
      if (cache) {
        store.put(cache, OFFLINE_IDB_CATALOG_KEY);
      } else {
        store.delete(OFFLINE_IDB_CATALOG_KEY);
      }
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

async function writePersistedIdbRecord(record: PersistedIdbRecord | null): Promise<boolean> {
  const db = await openOfflineSourceDb();
  if (!db) return false;
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction(OFFLINE_IDB_STORE, 'readwrite');
      const store = tx.objectStore(OFFLINE_IDB_STORE);
      if (record) {
        store.put(record, OFFLINE_IDB_KEY);
      } else {
        store.delete(OFFLINE_IDB_KEY);
      }
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

// ---------- Module Singleton State ----------

const initialPrefs = loadPersistedPrefs();

let exactEntryMap = new Map<string, ZipEntryRef>();
let lowerEntryMap = new Map<string, ZipEntryRef>();
let blobUrlLru = new Map<string, string>();
let mediaProfilesById = new Map<string, NinjaMediaProfile>();
let mediaProfilesByLower = new Map<string, NinjaMediaProfile>();
let offlineSonsMap: Record<string, string> = {};
let mountedArchives: MountedZipInfo[] = [];
let mountedRawFiles: File[] = [];
let mountedHandles: HandlePermissionApi[] = [];
let persistedHandlesAwaitingPermission: HandlePermissionApi[] = [];
let savedArchivesMeta: SavedOfflineArchiveMeta[] = initialPrefs.savedArchives;
let currentSourceMode: DataSourceMode = initialPrefs.sourceMode;
let mountedCatalog: ExtractResponse | null = null;
let cachedOfflineCatalog: ExtractResponse | null = null;
let mountedOrigin = 'https://naruto.jotagame.com';
let strictOfflineMode = initialPrefs.strictOffline;
let restoringPersisted = false;
let initStarted = false;
let stateGeneration = 0;
let lastStoreError: string | null = null;
const listeners = new Set<() => void>();

function syncPrefsToStorage() {
  savePersistedPrefs({
    sourceMode: currentSourceMode,
    strictOffline: strictOfflineMode,
    savedArchives: savedArchivesMeta,
  });
}

function revokeAllBlobUrls() {
  for (const url of blobUrlLru.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore revoke errors
    }
  }
  blobUrlLru.clear();
}

function cacheBlobUrl(key: string, blobUrl: string): string {
  const existing = blobUrlLru.get(key);
  if (existing) {
    blobUrlLru.delete(key);
    blobUrlLru.set(key, existing);
    return existing;
  }
  if (blobUrlLru.size >= MAX_BLOB_CACHE) {
    const oldest = blobUrlLru.entries().next().value as [string, string] | undefined;
    if (oldest) {
      blobUrlLru.delete(oldest[0]);
      try {
        URL.revokeObjectURL(oldest[1]);
      } catch {
        // ignore
      }
    }
  }
  blobUrlLru.set(key, blobUrl);
  return blobUrl;
}

function computeCoverageStats(): OfflineCoverageStats {
  let totalBytes = 0;
  let spineAtlases = 0;
  let spriteSheets = 0;
  let particleFiles = 0;
  let videosMp4 = 0;
  let audiosMp3 = 0;
  let nameArts = 0;

  for (const entry of exactEntryMap.values()) {
    totalBytes += entry.uncompressedSize;
    const p = entry.path.toLowerCase();
    if (p.startsWith('_shinobi_backup/')) continue;
    if (p.endsWith('.mp4')) {
      videosMp4++;
    } else if (p.endsWith('.mp3') || p.endsWith('.ogg') || p.endsWith('.wav')) {
      audiosMp3++;
    } else if (p.includes('spine-no-estados/') || p.includes('/noe_') || p.includes('particulas/')) {
      particleFiles++;
    } else if (p.includes('namepic_') || p.includes('newnamepic_')) {
      nameArts++;
    } else if (p.endsWith('.atlas')) {
      spineAtlases++;
    } else if (/\.(webp|png|jpe?g)$/i.test(p)) {
      spriteSheets++;
    }
  }

  return {
    totalEntries: exactEntryMap.size,
    totalBytes,
    catalogNinjas: mountedCatalog?.ninjas.length || 0,
    spineAtlases,
    spriteSheets,
    particleFiles,
    videosMp4,
    audiosMp3,
    nameArts,
  };
}

let cachedSnapshot: OfflineZipSnapshot = buildSnapshot();

function buildSnapshot(): OfflineZipSnapshot {
  const hasMounted = mountedArchives.length > 0;
  const active = currentSourceMode === 'offline' && hasMounted;
  const canReauth = !hasMounted && persistedHandlesAwaitingPermission.length > 0;
  const needsReconnect = currentSourceMode === 'offline' && !hasMounted;
  const effectiveCatalog =
    mountedCatalog || (currentSourceMode === 'offline' ? cachedOfflineCatalog : null);

  return {
    sourceMode: currentSourceMode,
    active,
    hasMountedArchives: hasMounted,
    strictOffline: strictOfflineMode,
    generation: stateGeneration,
    origin: mountedOrigin,
    archives: [...mountedArchives],
    savedArchives: [...savedArchivesMeta],
    canOneClickReauthorize: canReauth,
    needsReconnect,
    restoring: restoringPersisted,
    hasCatalog: Boolean(effectiveCatalog),
    catalog: effectiveCatalog,
    stats: computeCoverageStats(),
    lastError: lastStoreError,
  };
}

function emitChange() {
  stateGeneration++;
  cachedSnapshot = buildSnapshot();
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeOfflineZip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOfflineZipSnapshot(): OfflineZipSnapshot {
  return cachedSnapshot;
}

export function useOfflineZipState(): OfflineZipSnapshot {
  return useSyncExternalStore(subscribeOfflineZip, getOfflineZipSnapshot, getOfflineZipSnapshot);
}

export function isOfflineBackupActive(): boolean {
  return currentSourceMode === 'offline' && mountedArchives.length > 0;
}

export function isStrictOfflineMode(): boolean {
  return currentSourceMode === 'offline' && mountedArchives.length > 0 && strictOfflineMode;
}

export function setStrictOfflineMode(enabled: boolean) {
  if (strictOfflineMode === enabled) return;
  strictOfflineMode = enabled;
  syncPrefsToStorage();
  emitChange();
}

export function setPreferredSourceMode(mode: DataSourceMode) {
  if (currentSourceMode === mode) return;
  currentSourceMode = mode;
  syncPrefsToStorage();
  emitChange();
}

export function getOfflineOrigin(): string {
  return mountedOrigin;
}

export function getOfflineSonsMap(): Record<string, string> {
  return offlineSonsMap;
}

export function getOfflineMediaProfile(ninjaId: string): NinjaMediaProfile | null {
  return (
    mediaProfilesById.get(ninjaId) ||
    mediaProfilesByLower.get(ninjaId.toLowerCase()) ||
    null
  );
}

export function normalizeUrlToZipPath(targetUrl: string): string | null {
  if (!targetUrl) return null;
  let candidate = targetUrl.trim();
  if (!candidate || candidate.startsWith('blob:') || candidate.startsWith('data:')) {
    return null;
  }

  // Unwrap local /api/proxy?url=... if present
  if (candidate.startsWith('/api/proxy?') || candidate.includes('/api/proxy?')) {
    try {
      const u = new URL(candidate, 'http://local.invalid');
      const inner = u.searchParams.get('url');
      if (inner) candidate = inner;
    } catch {
      // ignore
    }
  }

  try {
    if (/^https?:\/\//i.test(candidate)) {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname);
    } else {
      candidate = decodeURIComponent(candidate.split('?')[0]);
    }
  } catch {
    candidate = candidate.split('?')[0];
  }

  return sanitizeZipPath(candidate);
}

function findEntryByUrlOrPath(urlOrPath: string): ZipEntryRef | null {
  if (exactEntryMap.size === 0) return null;
  const rel = normalizeUrlToZipPath(urlOrPath);
  if (!rel) return null;

  const direct = exactEntryMap.get(rel) || lowerEntryMap.get(rel.toLowerCase());
  if (direct) return direct;

  // Fallback for single-character exported ZIPs where files live under `<ninjaId>/...`
  const baseName = rel.split('/').pop()?.toLowerCase();
  if (baseName) {
    if (rel.includes('/video/') && baseName.endsWith('.mp4')) {
      for (const [lowPath, ref] of lowerEntryMap) {
        if (lowPath.endsWith(`/${baseName}`) || lowPath === baseName) return ref;
      }
    }
    if (rel.includes('/som/') && baseName.endsWith('.mp3')) {
      for (const [lowPath, ref] of lowerEntryMap) {
        if (lowPath.endsWith(`/${baseName}`) || lowPath === baseName) return ref;
      }
    }
    if (rel.includes('/spine-no-estados/') || rel.includes('/spine/')) {
      for (const [lowPath, ref] of lowerEntryMap) {
        if (lowPath.endsWith(`/${baseName}`) || lowPath === baseName) return ref;
      }
    }
  }

  return null;
}

export function hasOfflineEntry(urlOrPath: string): boolean {
  return Boolean(findEntryByUrlOrPath(urlOrPath));
}

export function listOfflineEntryPathsByPredicate(
  predicate: (lowerPath: string) => boolean
): string[] {
  if (!isOfflineBackupActive() || exactEntryMap.size === 0) return [];
  const matches: string[] = [];
  for (const [lowPath, ref] of lowerEntryMap.entries()) {
    if (predicate(lowPath)) {
      matches.push(ref.path);
    }
  }
  return matches;
}

export async function readOfflineEntryBytes(urlOrPath: string): Promise<ArrayBuffer | null> {
  if (!isOfflineBackupActive()) return null;
  const entry = findEntryByUrlOrPath(urlOrPath);
  if (!entry) return null;
  const blob = await readEntryBlobAsync(entry);
  return await blob.arrayBuffer();
}

/**
 * Synchronous zero-copy Blob URL lookup for STORE entries with verified offsets.
 * Uses File.slice() directly against Android's file handle with zero RAM copy!
 */
export function resolveOfflineAssetUrlSync(targetUrl: string): string | null {
  const entry = findEntryByUrlOrPath(targetUrl);
  if (!entry) return null;

  const existing = blobUrlLru.get(entry.path);
  if (existing) {
    blobUrlLru.delete(entry.path);
    blobUrlLru.set(entry.path, existing);
    return existing;
  }

  if (
    entry.compressionMethod === 0 &&
    entry.verifiedOffset &&
    entry.dataOffset >= 0 &&
    entry.uncompressedSize >= 0 &&
    entry.dataOffset + entry.uncompressedSize <= entry.file.size
  ) {
    const slice = entry.file.slice(
      entry.dataOffset,
      entry.dataOffset + entry.uncompressedSize,
      guessMimeType(entry.path)
    );
    const blobUrl = URL.createObjectURL(slice);
    return cacheBlobUrl(entry.path, blobUrl);
  }

  return null;
}

export async function readOfflineBlobUrl(urlOrPath: string): Promise<string | null> {
  const entry = findEntryByUrlOrPath(urlOrPath);
  if (!entry) return null;

  const existing = blobUrlLru.get(entry.path);
  if (existing) {
    blobUrlLru.delete(entry.path);
    blobUrlLru.set(entry.path, existing);
    return existing;
  }

  const blob = await readEntryBlobAsync(entry);
  const blobUrl = URL.createObjectURL(blob);
  return cacheBlobUrl(entry.path, blobUrl);
}

export async function readOfflineText(urlOrPath: string): Promise<string | null> {
  const entry = findEntryByUrlOrPath(urlOrPath);
  if (!entry) return null;
  const blob = await readEntryBlobAsync(entry);
  return await blob.text();
}

export async function readOfflineJson<T = unknown>(urlOrPath: string): Promise<T | null> {
  const text = await readOfflineText(urlOrPath);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Fallback catalog builder if the user loads a single-character exported ZIP
 * (e.g. `vdfno_100306_completo.zip`) that doesn't have `_shinobi_backup/catalog.json`.
 */
async function synthesizeFallbackCatalogFromEntries(): Promise<ExtractResponse | null> {
  const atlases: ZipEntryRef[] = [];
  for (const entry of exactEntryMap.values()) {
    const p = entry.path.toLowerCase();
    if (
      p.endsWith('.atlas') &&
      !p.includes('/particulas/') &&
      !p.includes('spine-no-estados/') &&
      !p.split('/').pop()?.startsWith('noe_')
    ) {
      atlases.push(entry);
    }
  }
  if (atlases.length === 0) return null;

  const ninjas: NinjaEntry[] = [];
  const hasAnyMp4 = Array.from(exactEntryMap.keys()).some((p) => p.toLowerCase().endsWith('.mp4'));

  for (const a of atlases) {
    const fileName = a.path.split('/').pop() || '';
    const id = fileName.replace(/\.atlas$/i, '');
    if (!id) continue;
    const skelPath = a.path.replace(/\.atlas$/i, '.json');
    const codeMatch = id.match(/(\d+)$/);
    const kind = id.toLowerCase().startsWith('vdfno_')
      ? 'character'
      : /(_effect|_highteffect|_ground)$/i.test(id)
      ? 'effect'
      : 'character';

    ninjas.push({
      id,
      code: codeMatch ? codeMatch[1] : id,
      width: 220,
      height: 220,
      offsetX: 0,
      offsetY: 0,
      atlasUrl: `${mountedOrigin}/${a.path}`,
      skeletonUrl: `${mountedOrigin}/${skelPath}`,
      kind,
      sourceIndex: 'code',
      hasVideo: hasAnyMp4 && atlases.length === 1 ? true : undefined,
    });
  }

  if (ninjas.length === 0) return null;

  return {
    sourceUrl: 'local://backup.zip',
    resolvedGameUrl: 'ZIP Offline Local',
    gameTitle: `Backup Local (${mountedArchives.map((a) => a.fileName).join(', ')})`,
    ninjas,
    sheets: [],
    assets: [],
    stats: {
      scannedScripts: 0,
      discoveredAssets: 0,
      totalNinjas: ninjas.length,
      totalSheets: 0,
      elapsedMs: 0,
    },
  };
}

export async function mountBackupZipFiles(
  files: File[],
  options?: {
    append?: boolean;
    handles?: HandlePermissionApi[];
    activateOffline?: boolean;
    skipPersist?: boolean;
  }
): Promise<OfflineZipSnapshot> {
  const validFiles = files.filter((f) => f && f.size > 0);
  if (validFiles.length === 0) {
    throw new Error('Selecione ao menos um arquivo .zip válido.');
  }

  lastStoreError = null;
  const append = Boolean(options?.append);

  if (!append) {
    revokeAllBlobUrls();
    exactEntryMap = new Map();
    lowerEntryMap = new Map();
    mediaProfilesById = new Map();
    mediaProfilesByLower = new Map();
    offlineSonsMap = {};
    mountedArchives = [];
    mountedRawFiles = [];
    mountedHandles = [];
    mountedCatalog = null;
    mountedOrigin = 'https://naruto.jotagame.com';
  }

  for (const file of validFiles) {
    const parsed = await parseSingleZipIndex(file);
    const localExact = new Map<string, ZipEntryRef>();

    for (const entry of parsed.entries) {
      localExact.set(entry.path, entry);
      exactEntryMap.set(entry.path, entry);
      lowerEntryMap.set(entry.path.toLowerCase(), entry);
    }

    let meta: BackupMetaJson | null = null;
    const metaEntry = localExact.get('_shinobi_backup/meta.json');
    if (metaEntry) {
      try {
        const blob = await readEntryBlobAsync(metaEntry);
        meta = JSON.parse(await blob.text()) as BackupMetaJson;
        if (typeof meta.origin === 'string') {
          try {
            const parsedOrigin = new URL(meta.origin);
            if (parsedOrigin.protocol === 'https:' || parsedOrigin.protocol === 'http:') {
              mountedOrigin = parsedOrigin.origin;
            }
          } catch {
            // ignore invalid origin in metadata
          }
        }
      } catch {
        meta = null;
      }
    }

    const catalogEntry = localExact.get('_shinobi_backup/catalog.json');
    if (catalogEntry) {
      try {
        const blob = await readEntryBlobAsync(catalogEntry);
        const cat = JSON.parse(await blob.text()) as ExtractResponse;
        if (cat && Array.isArray(cat.ninjas)) {
          if (mountedCatalog && append) {
            // Merge catalogs cleanly by ninja id
            const byId = new Map<string, NinjaEntry>();
            for (const n of mountedCatalog.ninjas) byId.set(n.id, n);
            for (const n of cat.ninjas) byId.set(n.id, n);
            const mergedNinjas = Array.from(byId.values()).sort((a, b) =>
              a.id.localeCompare(b.id, undefined, { numeric: true })
            );
            mountedCatalog = {
              ...cat,
              ninjas: mergedNinjas,
              stats: {
                ...cat.stats,
                totalNinjas: mergedNinjas.length,
              },
            };
          } else {
            mountedCatalog = cat;
          }
        }
      } catch {
        // ignore corrupt catalog
      }
    }

    const profilesEntry = localExact.get('_shinobi_backup/media-profiles.json');
    if (profilesEntry) {
      try {
        const blob = await readEntryBlobAsync(profilesEntry);
        const parsedProfiles = JSON.parse(await blob.text()) as Record<string, NinjaMediaProfile>;
        if (parsedProfiles && typeof parsedProfiles === 'object') {
          for (const [id, prof] of Object.entries(parsedProfiles)) {
            if (!prof) continue;
            mediaProfilesById.set(id, prof);
            mediaProfilesByLower.set(id.toLowerCase(), prof);
          }
        }
      } catch {
        // ignore
      }
    }

    const bulkCombatEntry = localExact.get('_shinobi_backup/combate_e_habilidades.json');
    if (bulkCombatEntry) {
      try {
        const blob = await readEntryBlobAsync(bulkCombatEntry);
        const parsedCombat = JSON.parse(await blob.text()) as {
          ninjas?: Record<
            string,
            {
              ninjaId?: string;
              heroCode?: string;
              displayName?: string;
              combatProfile?: NinjaMediaProfile['combatProfile'];
              skills?: NinjaMediaProfile['skills'];
              passives?: NinjaMediaProfile['passives'];
            }
          >;
        };
        if (parsedCombat?.ninjas && typeof parsedCombat.ninjas === 'object') {
          for (const [id, entry] of Object.entries(parsedCombat.ninjas)) {
            if (!entry) continue;
            const existing = mediaProfilesById.get(id) || mediaProfilesByLower.get(id.toLowerCase());
            const merged: NinjaMediaProfile = existing
              ? {
                  ...existing,
                  heroCode: existing.heroCode || entry.heroCode,
                  displayName: existing.displayName || entry.displayName,
                  combatProfile: existing.combatProfile || entry.combatProfile,
                  skills:
                    existing.skills && Object.keys(existing.skills).length > 0
                      ? existing.skills
                      : entry.skills || existing.skills,
                  passives:
                    existing.passives && existing.passives.length > 0
                      ? existing.passives
                      : entry.passives || existing.passives,
                }
              : {
                  ninjaId: entry.ninjaId || id,
                  heroCode: entry.heroCode,
                  displayName: entry.displayName,
                  combatProfile: entry.combatProfile,
                  skills: entry.skills || {},
                  passives: entry.passives || [],
                  passiveAura: null,
                  videos: [],
                  voices: [],
                  soundUrlMap: {},
                  videoUrlMap: {},
                  originBase: mountedOrigin,
                };
            mediaProfilesById.set(id, merged);
            mediaProfilesByLower.set(id.toLowerCase(), merged);
          }
        }
      } catch {
        // ignore
      }
    }

    // Also hydrate single-character or batch exported ZIPs that contain combate_e_habilidades.json
    for (const [entryPath, entryRef] of localExact.entries()) {
      const lowerPath = entryPath.toLowerCase();
      if (
        lowerPath === '_shinobi_backup/combate_e_habilidades.json' ||
        !(
          lowerPath === 'combate_e_habilidades.json' ||
          lowerPath.endsWith('/combate_e_habilidades.json')
        )
      ) {
        continue;
      }
      try {
        const blob = await readEntryBlobAsync(entryRef);
        const parsedSingle = JSON.parse(await blob.text()) as {
          ninjaId?: string;
          heroCode?: string;
          displayName?: string;
          combatProfile?: NinjaMediaProfile['combatProfile'];
          skills?: NinjaMediaProfile['skills'];
          passives?: NinjaMediaProfile['passives'];
        };
        const id = typeof parsedSingle?.ninjaId === 'string' ? parsedSingle.ninjaId.trim() : '';
        if (!id) continue;
        const existing = mediaProfilesById.get(id) || mediaProfilesByLower.get(id.toLowerCase());
        const merged: NinjaMediaProfile = existing
          ? {
              ...existing,
              heroCode: existing.heroCode || parsedSingle.heroCode,
              displayName: existing.displayName || parsedSingle.displayName,
              combatProfile: existing.combatProfile || parsedSingle.combatProfile,
              skills:
                existing.skills && Object.keys(existing.skills).length > 0
                  ? existing.skills
                  : parsedSingle.skills || existing.skills,
              passives:
                existing.passives && existing.passives.length > 0
                  ? existing.passives
                  : parsedSingle.passives || existing.passives,
            }
          : {
              ninjaId: id,
              heroCode: parsedSingle.heroCode,
              displayName: parsedSingle.displayName,
              combatProfile: parsedSingle.combatProfile,
              skills: parsedSingle.skills || {},
              passives: parsedSingle.passives || [],
              passiveAura: null,
              videos: [],
              voices: [],
              soundUrlMap: {},
              videoUrlMap: {},
              originBase: mountedOrigin,
            };
        mediaProfilesById.set(id, merged);
        mediaProfilesByLower.set(id.toLowerCase(), merged);
      } catch {
        // ignore invalid single combat json
      }
    }

    const sonsEntry = localExact.get('_shinobi_backup/sons.json');
    if (sonsEntry) {
      try {
        const blob = await readEntryBlobAsync(sonsEntry);
        const parsedSons = JSON.parse(await blob.text()) as Record<string, string>;
        if (parsedSons && typeof parsedSons === 'object') {
          offlineSonsMap = { ...offlineSonsMap, ...parsedSons };
        }
      } catch {
        // ignore
      }
    }

    const archiveId = `${file.name}::${file.size}::${file.lastModified}`;
    const existingIdx = mountedArchives.findIndex((a) => a.id === archiveId);
    const info: MountedZipInfo = {
      id: archiveId,
      fileName: file.name,
      fileSize: file.size,
      entryCount: parsed.entries.length,
      moduleId: meta?.moduleId,
      label: meta?.label,
      createdAt: meta?.createdAt,
      isStoreFastPath: parsed.isStoreFastPath,
    };
    if (existingIdx >= 0) {
      mountedArchives[existingIdx] = info;
      mountedRawFiles[existingIdx] = file;
    } else {
      mountedArchives.push(info);
      mountedRawFiles.push(file);
    }
  }

  if (options?.handles && options.handles.length > 0) {
    mountedHandles = append ? [...mountedHandles, ...options.handles] : [...options.handles];
  } else if (!append) {
    mountedHandles = [];
  }

  persistedHandlesAwaitingPermission = [];

  // If no formal catalog.json was found in any loaded ZIP, try synthesizing from exported character ZIPs
  if (!mountedCatalog) {
    mountedCatalog = await synthesizeFallbackCatalogFromEntries();
  }

  if (options?.activateOffline !== false) {
    currentSourceMode = 'offline';
  }

  if (mountedCatalog) {
    cachedOfflineCatalog = mountedCatalog;
  }

  if (!options?.skipPersist) {
    const now = Date.now();
    savedArchivesMeta = mountedArchives.map((a) => ({
      fileName: a.fileName,
      fileSize: a.fileSize,
      entryCount: a.entryCount,
      label: a.label,
      savedAt: now,
    }));
    syncPrefsToStorage();

    if (mountedCatalog) {
      void writePersistedCatalogCache({
        catalog: mountedCatalog,
        origin: mountedOrigin,
        savedAt: now,
      });
    }

    if (mountedHandles.length > 0 && mountedHandles.length === mountedArchives.length) {
      // Zero-copy persistent handle reference (works for 7 GB+ ZIPs on Chrome/Edge!)
      void writePersistedIdbRecord({
        kind: 'handles',
        handles: mountedHandles,
        savedAt: now,
      });
    } else {
      const totalBytes = mountedRawFiles.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > 0 && totalBytes <= MAX_IDB_INLINE_FILE_BYTES) {
        void writePersistedIdbRecord({
          kind: 'files',
          files: mountedRawFiles,
          savedAt: now,
        });
      } else {
        // Avoid cloning multi-GB files into browser quota on Android; keep metadata + catalog + preference saved
        void writePersistedIdbRecord(null);
      }
    }
  }

  emitChange();
  return cachedSnapshot;
}

export async function pickAndMountOfflineZipFiles(options?: {
  append?: boolean;
}): Promise<
  | { status: 'mounted'; snapshot: OfflineZipSnapshot }
  | { status: 'cancelled' }
  | { status: 'fallback-input' }
> {
  const win = typeof window !== 'undefined' ? (window as unknown as {
    showOpenFilePicker?: (opts?: unknown) => Promise<HandlePermissionApi[]>;
  }) : null;

  if (!win || typeof win.showOpenFilePicker !== 'function') {
    return { status: 'fallback-input' };
  }

  let handles: HandlePermissionApi[];
  try {
    handles = await win.showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Pacotes ZIP de Backup',
          accept: {
            'application/zip': ['.zip'],
            'application/x-zip-compressed': ['.zip'],
            'application/octet-stream': ['.zip'],
          },
        },
      ],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    // Cross-origin iframe / unsupported mobile picker -> fallback cleanly to <input type="file">
    return { status: 'fallback-input' };
  }

  if (!handles || handles.length === 0) {
    return { status: 'cancelled' };
  }

  const validFiles: File[] = [];
  const validHandles: HandlePermissionApi[] = [];
  for (const h of handles) {
    try {
      const f = await h.getFile();
      if (f.size < 22) continue;
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      if (head[0] === 0x50 && head[1] === 0x4b) {
        validFiles.push(f);
        validHandles.push(h);
      }
    } catch {
      // ignore unreadable entry
    }
  }

  if (validFiles.length === 0) {
    throw new Error('Selecione arquivos válidos no formato .zip.');
  }

  const snapshot = await mountBackupZipFiles(validFiles, {
    append: options?.append,
    handles: validHandles,
    activateOffline: true,
  });
  return { status: 'mounted', snapshot };
}

export async function reauthorizeSavedOfflineHandles(): Promise<boolean> {
  if (persistedHandlesAwaitingPermission.length === 0) return false;
  restoringPersisted = true;
  lastStoreError = null;
  emitChange();

  try {
    const files: File[] = [];
    const grantedHandles: HandlePermissionApi[] = [];

    for (const handle of persistedHandlesAwaitingPermission) {
      let perm: string = 'granted';
      if (typeof handle.queryPermission === 'function') {
        perm = await handle.queryPermission({ mode: 'read' });
      }
      if (perm !== 'granted' && typeof handle.requestPermission === 'function') {
        perm = await handle.requestPermission({ mode: 'read' });
      }
      if (perm !== 'granted') {
        restoringPersisted = false;
        emitChange();
        return false;
      }
      const file = await handle.getFile();
      files.push(file);
      grantedHandles.push(handle);
    }

    if (files.length === 0) {
      restoringPersisted = false;
      emitChange();
      return false;
    }

    await mountBackupZipFiles(files, {
      handles: grantedHandles,
      activateOffline: true,
      skipPersist: false,
    });
    return true;
  } catch (err) {
    lastStoreError =
      err instanceof Error ? err.message : 'Não foi possível reabrir o arquivo offline salvo.';
    return false;
  } finally {
    restoringPersisted = false;
    emitChange();
  }
}

export async function initPersistedOfflineSource(): Promise<void> {
  if (initStarted) return;
  initStarted = true;

  // Hydrate cached offline catalog immediately so Offline Mode stays populated on reload
  const cachedCat = await readPersistedCatalogCache();
  if (cachedCat?.catalog && Array.isArray(cachedCat.catalog.ninjas)) {
    cachedOfflineCatalog = cachedCat.catalog;
    if (cachedCat.origin) {
      mountedOrigin = cachedCat.origin;
    }
    emitChange();
  }

  const record = await readPersistedIdbRecord();
  if (!record) return;

  restoringPersisted = true;
  emitChange();

  try {
    if (record.kind === 'files' && Array.isArray(record.files) && record.files.length > 0) {
      await mountBackupZipFiles(record.files, {
        activateOffline: currentSourceMode === 'offline',
        skipPersist: true,
      });
      return;
    }

    if (record.kind === 'handles' && Array.isArray(record.handles) && record.handles.length > 0) {
      let allGranted = true;
      for (const h of record.handles) {
        if (typeof h.queryPermission === 'function') {
          const perm = await h.queryPermission({ mode: 'read' });
          if (perm !== 'granted') {
            allGranted = false;
            break;
          }
        }
      }

      if (allGranted) {
        const files: File[] = [];
        for (const h of record.handles) {
          files.push(await h.getFile());
        }
        await mountBackupZipFiles(files, {
          handles: record.handles,
          activateOffline: currentSourceMode === 'offline',
          skipPersist: true,
        });
      } else {
        persistedHandlesAwaitingPermission = record.handles;
      }
    }
  } catch {
    // Saved file may have been moved/deleted; keep metadata so user can reconnect cleanly
    if (record.kind === 'handles') {
      persistedHandlesAwaitingPermission = [];
      void writePersistedIdbRecord(null);
    }
  } finally {
    restoringPersisted = false;
    emitChange();
  }
}

export function unmountBackupZip(options?: { keepPreference?: boolean }): void {
  revokeAllBlobUrls();
  exactEntryMap = new Map();
  lowerEntryMap = new Map();
  mediaProfilesById = new Map();
  mediaProfilesByLower = new Map();
  offlineSonsMap = {};
  mountedArchives = [];
  mountedRawFiles = [];
  mountedHandles = [];
  persistedHandlesAwaitingPermission = [];
  mountedCatalog = null;
  mountedOrigin = 'https://naruto.jotagame.com';
  lastStoreError = null;

  if (!options?.keepPreference) {
    cachedOfflineCatalog = null;
    currentSourceMode = 'online';
    savedArchivesMeta = [];
    syncPrefsToStorage();
    void writePersistedIdbRecord(null);
    void writePersistedCatalogCache(null);
  }

  emitChange();
}
