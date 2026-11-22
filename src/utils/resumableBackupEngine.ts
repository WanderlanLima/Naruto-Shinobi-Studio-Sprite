import type { ExtractResponse, NinjaEntry } from '../types/sprite';
import { downloadBlob, extractSpineEffectRefs, parseAtlas } from './atlasParser';
import {
  buildCorsRelayUrl,
  buildWsrvImageUrl,
  fetchStaticCatalogJson,
  fetchStaticZip,
  getSavedCorsProxy,
  isStaticHostingMode,
  loadStaticAtlasPack,
  loadStaticEffectsPack,
  readStaticPackFileBytes,
} from './remoteClient';
import {
  assembleStreamingZipBlob,
  computeCrc32,
  streamZipToWritable,
  type StreamingZipEntry,
} from './streamingZip';

export interface BackupModulePlanItem {
  id: string;
  module: 'base' | 'videos' | 'audios' | 'particles' | 'sprites' | 'assets';
  part: number;
  totalParts: number;
  label: string;
  description: string;
  filename: string;
  fileCount: number;
  estimatedBytes: number;
  recommended: boolean;
  requiresCorsProxyInStatic?: boolean;
}

export interface BackupPlanResponse {
  origin: string;
  gameTitle: string;
  totalCatalogNinjas: number;
  mp4NinjaCount: number;
  modules: BackupModulePlanItem[];
  completeFileCount: number;
  completeEstimatedBytes: number;
  planSource?: 'server' | 'static';
}

export interface BackupFileSpec {
  path: string;
  size: number;
}

interface StaticBackupManifestPayload {
  origin: string;
  generatedAt: string;
  baseFiles: Array<[string, number]>;
  videoFiles: Array<[string, number]>;
  audioFiles: Array<[string, number]>;
  particleFiles: Array<[string, number]>;
  spriteFiles: Array<[string, number]>;
  assetFiles: Array<[string, number]>;
}

export interface StaticBackupPlanBundle {
  plan: BackupPlanResponse;
  origin: string;
  moduleFilesById: Map<string, BackupFileSpec[]>;
  completeFiles: BackupFileSpec[];
  videoFiles: BackupFileSpec[];
  audioFiles: BackupFileSpec[];
  allKnownSizeMap: Map<string, number>;
}

export type ResumableJobStatus = 'running' | 'paused' | 'assembling' | 'completed' | 'error';
export type ResumablePauseReason = 'user' | 'network' | 'cors' | null;

export interface ResumableBackupJob {
  id: string;
  moduleId: string;
  label: string;
  filename: string;
  origin: string;
  files: BackupFileSpec[];
  completedPaths: string[];
  failedPaths: string[];
  corsSkippedPaths: string[];
  downloadedBytes: number;
  totalEstimatedBytes: number;
  includeCatalogMeta: boolean;
  customNinjaIds?: string[];
  status: ResumableJobStatus;
  pauseReason: ResumablePauseReason;
  statusMessage: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredBackupFileRecord {
  key: string; // `${jobId}::${path}`
  jobId: string;
  path: string;
  blob: Blob;
  size: number;
  crc32: number;
}

export interface BackupProgressUpdate {
  job: ResumableBackupJob;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  currentFile: string;
  assemblePercent: number;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write(data: BufferSource | Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

const ARCHIVE_FAST_COMMENT = 'SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA';
const DB_NAME = 'shinobi_resumable_backup_v1';
const DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_FILES = 'files';

const memoryJobs = new Map<string, ResumableBackupJob>();
const memoryFiles = new Map<string, StoredBackupFileRecord>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let cachedStaticManifestPromise: Promise<StaticBackupManifestPayload | null> | null = null;

function openBackupDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_JOBS)) {
            db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_FILES)) {
            const store = db.createObjectStore(STORE_FILES, { keyPath: 'key' });
            store.createIndex('jobId', 'jobId', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
}

export async function getLatestSavedBackupJob(): Promise<ResumableBackupJob | null> {
  const db = await openBackupDb();
  if (!db) {
    const list = Array.from(memoryJobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = list[0] || null;
    if (latest && (latest.status === 'running' || latest.status === 'assembling')) {
      latest.status = 'paused';
      latest.pauseReason = latest.pauseReason || 'user';
      latest.statusMessage = 'Download interrompido anteriormente — pronto para retomar de onde parou.';
    }
    return latest;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readonly');
      const req = tx.objectStore(STORE_JOBS).getAll();
      req.onsuccess = () => {
        const list = (req.result as ResumableBackupJob[]) || [];
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        const latest = list[0] || null;
        if (latest && (latest.status === 'running' || latest.status === 'assembling')) {
          latest.status = 'paused';
          latest.pauseReason = latest.pauseReason || 'user';
          latest.statusMessage =
            'Download interrompido anteriormente — pronto para retomar de onde parou.';
        }
        resolve(latest);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveBackupJobRecord(job: ResumableBackupJob): Promise<void> {
  const updated: ResumableBackupJob = { ...job, updatedAt: Date.now() };
  memoryJobs.set(updated.id, updated);
  const db = await openBackupDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_JOBS, 'readwrite');
      tx.objectStore(STORE_JOBS).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function saveBackupFileBatch(records: StoredBackupFileRecord[]): Promise<void> {
  if (records.length === 0) return;
  for (const r of records) {
    memoryFiles.set(r.key, r);
  }
  const db = await openBackupDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      const store = tx.objectStore(STORE_FILES);
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearAllResumableBackupJobs(): Promise<void> {
  memoryJobs.clear();
  memoryFiles.clear();
  const db = await openBackupDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_JOBS, STORE_FILES], 'readwrite');
      tx.objectStore(STORE_JOBS).clear();
      tx.objectStore(STORE_FILES).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function* iterateStoredJobFiles(
  jobId: string,
  metaEntries: StreamingZipEntry[]
): AsyncIterable<StreamingZipEntry[]> {
  if (metaEntries.length > 0) {
    yield metaEntries;
  }

  const db = await openBackupDb();
  if (!db) {
    const batch: StreamingZipEntry[] = [];
    for (const rec of memoryFiles.values()) {
      if (rec.jobId !== jobId) continue;
      batch.push({ path: rec.path, size: rec.size, crc32: rec.crc32, blob: rec.blob });
      if (batch.length >= 25) {
        yield batch.splice(0, batch.length);
      }
    }
    if (batch.length > 0) yield batch;
    return;
  }

  // Stream records in chunks using an IDB cursor so RAM stays flat even for thousands of files
  const allKeys = await new Promise<IDBValidKey[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const idx = tx.objectStore(STORE_FILES).index('jobId');
      const req = idx.getAllKeys(IDBKeyRange.only(jobId));
      req.onsuccess = () => resolve((req.result as IDBValidKey[]) || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  const BATCH = 24;
  for (let i = 0; i < allKeys.length; i += BATCH) {
    const sliceKeys = allKeys.slice(i, i + BATCH);
    const records = await new Promise<StoredBackupFileRecord[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_FILES, 'readonly');
        const store = tx.objectStore(STORE_FILES);
        const out: StoredBackupFileRecord[] = [];
        let pending = sliceKeys.length;
        if (pending === 0) {
          resolve([]);
          return;
        }
        for (const k of sliceKeys) {
          const r = store.get(k);
          r.onsuccess = () => {
            if (r.result) out.push(r.result as StoredBackupFileRecord);
            pending--;
            if (pending === 0) resolve(out);
          };
          r.onerror = () => {
            pending--;
            if (pending === 0) resolve(out);
          };
        }
      } catch {
        resolve([]);
      }
    });

    if (records.length > 0) {
      yield records.map((rec) => ({
        path: rec.path,
        size: rec.size,
        crc32: rec.crc32,
        blob: rec.blob,
      }));
    }
  }
}

function makeJsonZipEntry(path: string, data: unknown): StreamingZipEntry {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return {
    path,
    size: bytes.byteLength,
    crc32: computeCrc32(bytes),
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/json' }),
  };
}

function partitionFilesBySize(
  files: BackupFileSpec[],
  maxBytesPerPart: number
): Array<{ files: BackupFileSpec[]; bytes: number }> {
  const parts: Array<{ files: BackupFileSpec[]; bytes: number }> = [];
  let current: BackupFileSpec[] = [];
  let currentBytes = 0;

  for (const f of files) {
    const sz = Math.max(1024, f.size || 64 * 1024);
    if (current.length > 0 && currentBytes + sz > maxBytesPerPart) {
      parts.push({ files: current, bytes: currentBytes });
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += sz;
  }
  if (current.length > 0) {
    parts.push({ files: current, bytes: currentBytes });
  }
  return parts;
}

function toSafeRelPath(rawUrl: string, expectedOrigin: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== expectedOrigin) return null;
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || /[\x00-\x1f]/.test(rel)) return null;
    return rel;
  } catch {
    return null;
  }
}

async function loadStaticManifestPayload(): Promise<StaticBackupManifestPayload | null> {
  if (!cachedStaticManifestPromise) {
    cachedStaticManifestPromise = (async () => {
      const { zip } = await fetchStaticZip('data/backup-manifest.zip');
      if (!zip) {
        cachedStaticManifestPromise = null;
        return null;
      }
      const f = zip.file('backup-manifest.json');
      if (!f) {
        cachedStaticManifestPromise = null;
        return null;
      }
      try {
        return JSON.parse(await f.async('text')) as StaticBackupManifestPayload;
      } catch {
        cachedStaticManifestPromise = null;
        return null;
      }
    })();
  }
  return cachedStaticManifestPromise;
}

function pairsToSpecs(pairs: Array<[string, number]> | undefined): BackupFileSpec[] {
  if (!Array.isArray(pairs)) return [];
  return pairs.map(([path, size]) => ({ path, size: Number(size) || 0 }));
}

/**
 * Builds an exact modular & single-file backup plan purely client-side
 * using public/data/backup-manifest.zip (with zero-failure fallback to the
 * static catalog + atlas packs if backup-manifest.zip is ever absent).
 */
export async function loadStaticBackupPlanBundle(
  ninjas: NinjaEntry[],
  sourceUrl: string
): Promise<StaticBackupPlanBundle> {
  const manifest = await loadStaticManifestPayload();
  const origin = manifest?.origin || 'https://naruto.jotagame.com';

  let baseFiles: BackupFileSpec[] = [];
  let videoFiles: BackupFileSpec[] = [];
  let audioFiles: BackupFileSpec[] = [];
  let particleFiles: BackupFileSpec[] = [];
  let spriteFiles: BackupFileSpec[] = [];
  let assetFiles: BackupFileSpec[] = [];

  if (manifest) {
    baseFiles = pairsToSpecs(manifest.baseFiles);
    videoFiles = pairsToSpecs(manifest.videoFiles);
    audioFiles = pairsToSpecs(manifest.audioFiles);
    particleFiles = pairsToSpecs(manifest.particleFiles);
    spriteFiles = pairsToSpecs(manifest.spriteFiles);
    assetFiles = pairsToSpecs(manifest.assetFiles);
  } else {
    // Fallback synthesis directly from catalog + static atlas packs
    const catalog = await fetchStaticCatalogJson();
    const list = ninjas.length > 0 ? ninjas : catalog?.ninjas || [];
    const baseSet = new Set<string>();
    const spriteSet = new Set<string>();

    for (const n of list) {
      const a = toSafeRelPath(n.atlasUrl, origin);
      const s = toSafeRelPath(n.skeletonUrl, origin);
      const art = n.nameArtUrl ? toSafeRelPath(n.nameArtUrl, origin) : null;
      if (a) baseSet.add(a);
      if (s) baseSet.add(s);
      if (art) baseSet.add(art);
    }

    const mainPack = await loadStaticAtlasPack();
    if (mainPack) {
      for (const entry of Object.values(mainPack.idleMap)) {
        if (entry?.page) {
          spriteSet.add(`acervo/asset/spine/${entry.page}`);
        }
      }
    }
    for (const sheet of catalog?.sheets || []) {
      const rel = toSafeRelPath(sheet.url, origin);
      if (rel) spriteSet.add(rel);
    }

    baseFiles = Array.from(baseSet)
      .sort()
      .map((path) => ({ path, size: 48 * 1024 }));
    spriteFiles = Array.from(spriteSet)
      .sort()
      .map((path) => ({ path, size: 600 * 1024 }));
  }

  const allKnownSizeMap = new Map<string, number>();
  for (const list of [baseFiles, videoFiles, audioFiles, particleFiles, spriteFiles, assetFiles]) {
    for (const f of list) allKnownSizeMap.set(f.path, f.size);
  }

  const sumBytes = (list: BackupFileSpec[]) => list.reduce((acc, f) => acc + f.size, 0);
  const baseBytes = sumBytes(baseFiles) + 3 * 1024 * 1024;
  const videoBytes = sumBytes(videoFiles);
  const audioBytes = sumBytes(audioFiles);

  const particleParts = partitionFilesBySize(particleFiles, 250 * 1024 * 1024);
  const spriteParts = partitionFilesBySize(spriteFiles, 300 * 1024 * 1024);
  const assetParts = partitionFilesBySize(assetFiles, 280 * 1024 * 1024);

  const moduleFilesById = new Map<string, BackupFileSpec[]>();
  const modules: BackupModulePlanItem[] = [];

  moduleFilesById.set('base-1', baseFiles);
  modules.push({
    id: 'base-1',
    module: 'base',
    part: 1,
    totalParts: 1,
    label: '01. Base: Catálogo, Tabelas, Esqueletos, Auras e Nomes',
    description:
      'Obrigatório: catálogo completo, arquivos .atlas/.json (extração instantânea do pacote estático), auras passivas (Susano’o) e artes de nome.',
    filename: '01_shinobi_base_catalogo_esqueletos.zip',
    fileCount: baseFiles.length + 2,
    estimatedBytes: baseBytes,
    recommended: true,
  });

  if (videoFiles.length > 0) {
    moduleFilesById.set('videos-1', videoFiles);
    modules.push({
      id: 'videos-1',
      module: 'videos',
      part: 1,
      totalParts: 1,
      label: '02. Vídeos MP4 (Ultimates e Apresentação)',
      description:
        'Todos os vídeos MP4 de esotéricas/ultimates e apresentações de recrutamento dos ninjas.',
      filename: '02_shinobi_videos_mp4.zip',
      fileCount: videoFiles.length + 1,
      estimatedBytes: videoBytes,
      recommended: true,
      requiresCorsProxyInStatic: true,
    });
  }

  if (audioFiles.length > 0) {
    moduleFilesById.set('audios-1', audioFiles);
    modules.push({
      id: 'audios-1',
      module: 'audios',
      part: 1,
      totalParts: 1,
      label: '03. Áudios e Vozes MP3',
      description:
        'Todas as falas de batalha, vozes de ultimate, efeitos sonoros de golpes e áudios das animações.',
      filename: '03_shinobi_audios_vozes_mp3.zip',
      fileCount: audioFiles.length + 1,
      estimatedBytes: audioBytes,
      recommended: true,
      requiresCorsProxyInStatic: true,
    });
  }

  particleParts.forEach((p, idx) => {
    const partNum = idx + 1;
    const id = `particles-${partNum}`;
    moduleFilesById.set(id, p.files);
    modules.push({
      id,
      module: 'particles',
      part: partNum,
      totalParts: particleParts.length,
      label:
        particleParts.length > 1
          ? `04. Partículas e Efeitos de Combate (Parte ${partNum}/${particleParts.length})`
          : '04. Partículas e Efeitos de Combate',
      description:
        'Efeitos Spine vinculados (chamas negras, Susano’o, explosões, raios, golpes e partículas de habilidades).',
      filename: `04_shinobi_particulas_p${partNum}_de_${particleParts.length}.zip`,
      fileCount: p.files.length + 1,
      estimatedBytes: p.bytes,
      recommended: true,
    });
  });

  spriteParts.forEach((p, idx) => {
    const partNum = idx + 1;
    const id = `sprites-${partNum}`;
    moduleFilesById.set(id, p.files);
    modules.push({
      id,
      module: 'sprites',
      part: partNum,
      totalParts: spriteParts.length,
      label:
        spriteParts.length > 1
          ? `05. Folhas de Sprites dos Ninjas (Parte ${partNum}/${spriteParts.length})`
          : '05. Folhas de Sprites dos Ninjas',
      description:
        'Texturas WebP/PNG em qualidade máxima usadas pelos esqueletos Spine para renderizar os personagens, invocações e skins.',
      filename: `05_shinobi_sprites_p${partNum}_de_${spriteParts.length}.zip`,
      fileCount: p.files.length + 1,
      estimatedBytes: p.bytes,
      recommended: true,
    });
  });

  assetParts.forEach((p, idx) => {
    const partNum = idx + 1;
    const id = `assets-${partNum}`;
    moduleFilesById.set(id, p.files);
    modules.push({
      id,
      module: 'assets',
      part: partNum,
      totalParts: assetParts.length,
      label:
        assetParts.length > 1
          ? `06. Opcional: Emojis, UI, Itens e Cenários (Parte ${partNum}/${assetParts.length})`
          : '06. Opcional: Emojis, UI, Itens e Cenários',
      description:
        'Ativos extras exibidos na aba "Outros Ativos" (não obrigatórios para o Estúdio Spine).',
      filename: `06_shinobi_ativos_ui_p${partNum}_de_${assetParts.length}.zip`,
      fileCount: p.files.length + 1,
      estimatedBytes: p.bytes,
      recommended: false,
    });
  });

  const completeFiles: BackupFileSpec[] = [
    ...baseFiles,
    ...spriteFiles,
    ...particleFiles,
    ...videoFiles,
    ...audioFiles,
  ];
  const completeEstimatedBytes =
    baseBytes +
    videoBytes +
    audioBytes +
    sumBytes(particleFiles) +
    sumBytes(spriteFiles);

  const effectiveNinjas = ninjas.length > 0 ? ninjas : (await fetchStaticCatalogJson())?.ninjas || [];
  const mp4NinjaCount = effectiveNinjas.filter((n) => n.hasVideo).length || 139;

  return {
    origin,
    moduleFilesById,
    completeFiles,
    videoFiles,
    audioFiles,
    allKnownSizeMap,
    plan: {
      origin,
      gameTitle: sourceUrl.includes('naruto') ? 'Naruto Online' : 'Shinobi Sprite Studio',
      totalCatalogNinjas: effectiveNinjas.length,
      mp4NinjaCount,
      modules,
      completeFileCount: completeFiles.length + 2,
      completeEstimatedBytes,
      planSource: 'static',
    },
  };
}

/**
 * Resolves the exact files needed for a standalone subset of ninjas (Custom Selection or MP4 Preset),
 * extracting atlas page filenames & linked particle Spine IDs directly from our static packs.
 */
export async function resolveStandaloneNinjasFileList(
  selectedNinjas: NinjaEntry[],
  bundle: StaticBackupPlanBundle,
  options: {
    includeParticles: boolean;
    includeVideos: boolean;
    includeAudio: boolean;
    includeNameArt: boolean;
  }
): Promise<BackupFileSpec[]> {
  const origin = bundle.origin;
  const pathSet = new Set<string>();
  const effectIds = new Set<string>();
  const decoder = new TextDecoder('utf-8');

  // Pre-warm static atlas/effects packs in parallel
  await Promise.all([
    loadStaticAtlasPack(),
    options.includeParticles ? loadStaticEffectsPack() : Promise.resolve(null),
  ]);

  for (const ninja of selectedNinjas) {
    const atlasRel = toSafeRelPath(ninja.atlasUrl, origin);
    const skelRel = toSafeRelPath(ninja.skeletonUrl, origin);
    if (atlasRel) {
      pathSet.add(atlasRel);
      const atlasBytes = await readStaticPackFileBytes(atlasRel);
      if (atlasBytes) {
        const parsedPages = parseAtlas(decoder.decode(atlasBytes));
        for (const page of parsedPages) {
          try {
            const pageUrl = new URL(page.name, ninja.atlasUrl).toString();
            const pageRel = toSafeRelPath(pageUrl, origin);
            if (pageRel) pathSet.add(pageRel);
          } catch {
            // ignore
          }
        }
      }
    }
    if (skelRel) {
      pathSet.add(skelRel);
      if (options.includeParticles) {
        const skelBytes = await readStaticPackFileBytes(skelRel);
        if (skelBytes) {
          try {
            const skelObj = JSON.parse(decoder.decode(skelBytes));
            for (const animName of Object.keys(skelObj?.animations || {})) {
              for (const ref of extractSpineEffectRefs(skelObj, animName)) {
                effectIds.add(ref.spineId);
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }
    if (options.includeNameArt && ninja.nameArtUrl) {
      const artRel = toSafeRelPath(ninja.nameArtUrl, origin);
      if (artRel) pathSet.add(artRel);
    }
    if (options.includeVideos && ninja.code) {
      const codeLow = ninja.code.toLowerCase();
      for (const vf of bundle.videoFiles) {
        if (vf.path.toLowerCase().includes(codeLow)) {
          pathSet.add(vf.path);
        }
      }
    }
  }

  if (options.includeParticles) {
    for (const eid of effectIds) {
      const aRel = `acervo/asset/spine/${eid}.atlas`;
      const sRel = `acervo/asset/spine/${eid}.json`;
      pathSet.add(aRel);
      pathSet.add(sRel);
      const atlasBytes = await readStaticPackFileBytes(aRel);
      if (atlasBytes) {
        const parsedPages = parseAtlas(decoder.decode(atlasBytes));
        for (const page of parsedPages) {
          const pageRel = `acervo/asset/spine/${page.name.replace(/^\/+/, '')}`;
          pathSet.add(pageRel);
        }
      }
    }
  }

  return Array.from(pathSet)
    .sort()
    .map((path) => ({
      path,
      size: bundle.allKnownSizeMap.get(path) || 64 * 1024,
    }));
}

function isImagePath(relPath: string): boolean {
  return /\.(webp|png|jpe?g|gif)$/i.test(relPath);
}

function isAudioOrVideoPath(relPath: string): boolean {
  return /\.(mp4|mp3|ogg|wav|webm)$/i.test(relPath);
}

function resolveDownloadUrlForPath(
  origin: string,
  relPath: string
): { url: string | null; corsBlockedInStatic: boolean } {
  const fullUrl = `${origin}/${relPath.replace(/^\/+/, '')}`;

  if (!isStaticHostingMode()) {
    return {
      url: `/api/proxy?url=${encodeURIComponent(fullUrl)}`,
      corsBlockedInStatic: false,
    };
  }

  const customProxy = getSavedCorsProxy();
  if (customProxy) {
    return {
      url: buildCorsRelayUrl(fullUrl, customProxy),
      corsBlockedInStatic: false,
    };
  }

  if (isImagePath(relPath)) {
    return {
      url: buildWsrvImageUrl(fullUrl),
      corsBlockedInStatic: false,
    };
  }

  if (isAudioOrVideoPath(relPath)) {
    // Public free relays block/429 large MP4/MP3 binaries when no custom proxy is set
    return {
      url: null,
      corsBlockedInStatic: true,
    };
  }

  return {
    url: buildCorsRelayUrl(fullUrl, 'https://api.codetabs.com/v1/proxy?quest='),
    corsBlockedInStatic: false,
  };
}

async function fetchFileBytesWithRetry(
  origin: string,
  relPath: string,
  signal: AbortSignal,
  attempts = 4
): Promise<{
  bytes: Uint8Array | null;
  status: 'ok' | 'missing' | 'cors_blocked' | 'network_error';
}> {
  // Fast path #1: instant extraction from same-origin GitHub Pages static packs
  const staticBytes = await readStaticPackFileBytes(relPath);
  if (staticBytes && staticBytes.byteLength > 0) {
    return { bytes: staticBytes, status: 'ok' };
  }

  const resolved = resolveDownloadUrlForPath(origin, relPath);
  if (resolved.corsBlockedInStatic || !resolved.url) {
    return { bytes: null, status: 'cors_blocked' };
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const resp = await fetch(resolved.url, {
        signal,
        cache: 'force-cache',
      });
      if (resp.status === 404) {
        return { bytes: null, status: 'missing' };
      }
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          return { bytes: new Uint8Array(buf), status: 'ok' };
        }
        return { bytes: null, status: 'missing' };
      }
      if (resp.status === 403 || resp.status === 401) {
        return { bytes: null, status: 'cors_blocked' };
      }
    } catch (err) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (attempt === attempts - 1) {
        return { bytes: null, status: 'network_error' };
      }
    }
    const backoff = Math.min(3000, 350 * Math.pow(2, attempt));
    await new Promise((r) => setTimeout(r, backoff));
  }
  return { bytes: null, status: 'network_error' };
}

export async function assembleAndSaveBackupJobZip(
  job: ResumableBackupJob,
  ninjasForCatalog: NinjaEntry[],
  onProgress?: (percent: number) => void,
  options?: { preferFilePicker?: boolean }
): Promise<{ savedViaPicker: boolean }> {
  const metaEntries: StreamingZipEntry[] = [];
  metaEntries.push(
    makeJsonZipEntry('_shinobi_backup/meta.json', {
      format: 'shinobi-backup-v1',
      createdAt: new Date().toISOString(),
      origin: job.origin,
      moduleId: job.moduleId,
      label: job.label,
      storeZeroExtra: true,
      expectedFiles: job.files.length,
      completedFiles: job.completedPaths.length,
    })
  );

  if (job.includeCatalogMeta) {
    const baseCatalog = await fetchStaticCatalogJson();
    const allNinjas =
      ninjasForCatalog.length > 0 ? ninjasForCatalog : baseCatalog?.ninjas || [];
    const filteredNinjas = job.customNinjaIds?.length
      ? allNinjas.filter((n) => job.customNinjaIds!.includes(n.id))
      : allNinjas;

    const catalogPayload: ExtractResponse = {
      sourceUrl: baseCatalog?.sourceUrl || `${job.origin}/`,
      resolvedGameUrl: baseCatalog?.resolvedGameUrl || `${job.origin}/jogar?app=1`,
      gameTitle: baseCatalog?.gameTitle || 'Naruto Online',
      ninjas: filteredNinjas,
      sheets: job.customNinjaIds?.length ? [] : baseCatalog?.sheets || [],
      assets: job.customNinjaIds?.length ? [] : baseCatalog?.assets || [],
      stats: {
        scannedScripts: baseCatalog?.stats?.scannedScripts || 0,
        discoveredAssets: job.customNinjaIds?.length ? 0 : baseCatalog?.stats?.discoveredAssets || 0,
        totalNinjas: filteredNinjas.length,
        totalSheets: job.customNinjaIds?.length ? 0 : baseCatalog?.stats?.totalSheets || 0,
        elapsedMs: 0,
      },
    };
    metaEntries.push(makeJsonZipEntry('_shinobi_backup/catalog.json', catalogPayload));
  }

  const totalEntries = job.completedPaths.length + metaEntries.length;
  const pickerWin = typeof window !== 'undefined' ? (window as SaveFilePickerWindow) : null;
  const canUsePicker =
    Boolean(pickerWin?.showSaveFilePicker) &&
    (Boolean(options?.preferFilePicker) || job.downloadedBytes > 450 * 1024 * 1024);

  if (canUsePicker && pickerWin?.showSaveFilePicker) {
    try {
      const handle = await pickerWin.showSaveFilePicker({
        suggestedName: job.filename,
        types: [{ description: 'Arquivo ZIP', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      await streamZipToWritable(
        () => iterateStoredJobFiles(job.id, metaEntries),
        writable,
        totalEntries,
        onProgress,
        ARCHIVE_FAST_COMMENT
      );
      return { savedViaPicker: true };
    } catch (err) {
      // User cancelled picker or user-activation expired -> fall back seamlessly to Blob download
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
    }
  }

  const blob = await assembleStreamingZipBlob(
    () => iterateStoredJobFiles(job.id, metaEntries),
    totalEntries,
    onProgress,
    ARCHIVE_FAST_COMMENT
  );
  downloadBlob(blob, job.filename);
  return { savedViaPicker: false };
}

export interface BackupRunController {
  pause: () => void;
}

/**
 * High-speed resumable parallel download engine (up to 16 concurrent connections)
 * with batched IndexedDB checkpointing, automatic offline pause/resume, and
 * zero duplicate downloads on resume.
 */
export function startOrResumeBackupDownload(params: {
  existingJob?: ResumableBackupJob;
  retryFailedOnly?: boolean;
  newJobSpec?: {
    moduleId: string;
    label: string;
    filename: string;
    origin: string;
    files: BackupFileSpec[];
    includeCatalogMeta: boolean;
    customNinjaIds?: string[];
  };
  ninjasForCatalog: NinjaEntry[];
  onProgress: (update: BackupProgressUpdate) => void;
  onComplete: (job: ResumableBackupJob) => void;
  onPaused: (job: ResumableBackupJob) => void;
  onError: (job: ResumableBackupJob, message: string) => void;
}): BackupRunController {
  const abortCtrl = new AbortController();
  let userPaused = false;
  let networkPaused = false;

  const pause = () => {
    userPaused = true;
    abortCtrl.abort();
  };

  void (async () => {
    void requestPersistentStorage();

    let job: ResumableBackupJob;
    if (params.existingJob) {
      job = {
        ...params.existingJob,
        completedPaths: [...params.existingJob.completedPaths],
        failedPaths: params.retryFailedOnly ? [] : [...params.existingJob.failedPaths],
        corsSkippedPaths: [...(params.existingJob.corsSkippedPaths || [])],
        status: 'running',
        pauseReason: null,
        statusMessage: 'Retomando download de onde parou...',
        updatedAt: Date.now(),
      };
    } else if (params.newJobSpec) {
      await clearAllResumableBackupJobs();
      const spec = params.newJobSpec;
      const totalEstimatedBytes = spec.files.reduce((acc, f) => acc + (f.size || 0), 0);
      job = {
        id: `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        moduleId: spec.moduleId,
        label: spec.label,
        filename: spec.filename,
        origin: spec.origin,
        files: spec.files,
        completedPaths: [],
        failedPaths: [],
        corsSkippedPaths: [],
        downloadedBytes: 0,
        totalEstimatedBytes,
        includeCatalogMeta: spec.includeCatalogMeta,
        customNinjaIds: spec.customNinjaIds,
        status: 'running',
        pauseReason: null,
        statusMessage: 'Iniciando download em alta velocidade...',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      return;
    }

    await saveBackupJobRecord(job);

    const onBrowserOffline = () => {
      networkPaused = true;
      abortCtrl.abort();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', onBrowserOffline);
    }

    const completedSet = new Set(job.completedPaths);
    const failedSet = new Set(params.retryFailedOnly ? [] : job.failedPaths);
    const corsSkippedSet = new Set(job.corsSkippedPaths);

    const pendingFiles = params.retryFailedOnly && params.existingJob
      ? job.files.filter(
          (f) =>
            !completedSet.has(f.path) &&
            (params.existingJob!.failedPaths.includes(f.path) ||
              params.existingJob!.corsSkippedPaths.includes(f.path))
        )
      : job.files.filter((f) => !completedSet.has(f.path));

    // Pre-warm static packs in parallel if this job includes any .atlas or .json files
    const hasSpineMeta = pendingFiles.some(
      (f) => f.path.endsWith('.atlas') || f.path.endsWith('.json')
    );
    if (hasSpineMeta) {
      job.statusMessage = 'Carregando índices estáticos em alta velocidade...';
      params.onProgress({
        job: { ...job },
        speedBytesPerSec: 0,
        etaSeconds: null,
        currentFile: '',
        assemblePercent: 0,
      });
      await Promise.all([loadStaticAtlasPack(), loadStaticEffectsPack()]);
    }

    const isMobile =
      typeof navigator !== 'undefined' && /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    const concurrency = isMobile ? 12 : 16;

    let queueIdx = 0;
    let consecutiveNetworkErrors = 0;
    let currentFile = '';
    const pendingDbWrites: StoredBackupFileRecord[] = [];
    let pendingDbBytes = 0;
    let lastDbFlushTs = Date.now();
    let lastUiEmitTs = 0;

    // Rolling speed window (last 4 seconds)
    const speedSamples: Array<{ ts: number; bytes: number }> = [];
    let sessionBytes = 0;

    const computeSpeedAndEta = () => {
      const now = Date.now();
      while (speedSamples.length > 0 && now - speedSamples[0].ts > 4000) {
        speedSamples.shift();
      }
      const windowBytes = speedSamples.reduce((s, x) => s + x.bytes, 0);
      const spanSec =
        speedSamples.length >= 2
          ? Math.max(0.25, (now - speedSamples[0].ts) / 1000)
          : 1;
      const speedBytesPerSec = windowBytes / spanSec;
      const remainingBytes = Math.max(0, job.totalEstimatedBytes - job.downloadedBytes);
      const etaSeconds =
        speedBytesPerSec > 1024 && remainingBytes > 0
          ? Math.round(remainingBytes / speedBytesPerSec)
          : null;
      return { speedBytesPerSec, etaSeconds };
    };

    const flushCheckpoint = async (force = false) => {
      if (
        !force &&
        pendingDbWrites.length < 12 &&
        pendingDbBytes < 4 * 1024 * 1024 &&
        Date.now() - lastDbFlushTs < 1800
      ) {
        return;
      }
      const batch = pendingDbWrites.splice(0, pendingDbWrites.length);
      pendingDbBytes = 0;
      lastDbFlushTs = Date.now();
      if (batch.length > 0) {
        await saveBackupFileBatch(batch);
      }
      job.completedPaths = Array.from(completedSet);
      job.failedPaths = Array.from(failedSet);
      job.corsSkippedPaths = Array.from(corsSkippedSet);
      await saveBackupJobRecord(job);
    };

    const emitUi = (force = false) => {
      const now = Date.now();
      if (!force && now - lastUiEmitTs < 180) return;
      lastUiEmitTs = now;
      job.completedPaths = Array.from(completedSet);
      job.failedPaths = Array.from(failedSet);
      job.corsSkippedPaths = Array.from(corsSkippedSet);
      const { speedBytesPerSec, etaSeconds } = computeSpeedAndEta();
      params.onProgress({
        job: { ...job },
        speedBytesPerSec,
        etaSeconds,
        currentFile,
        assemblePercent: 0,
      });
    };

    try {
      const worker = async () => {
        while (!abortCtrl.signal.aborted) {
          const i = queueIdx++;
          if (i >= pendingFiles.length) break;
          const fileSpec = pendingFiles[i];
          currentFile = fileSpec.path.split('/').pop() || fileSpec.path;

          const res = await fetchFileBytesWithRetry(
            job.origin,
            fileSpec.path,
            abortCtrl.signal,
            4
          );

          if (res.status === 'ok' && res.bytes) {
            consecutiveNetworkErrors = 0;
            const bytes = res.bytes;
            const size = bytes.byteLength;
            const crc32 = computeCrc32(bytes);
            const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);

            completedSet.add(fileSpec.path);
            failedSet.delete(fileSpec.path);
            corsSkippedSet.delete(fileSpec.path);
            job.downloadedBytes += size;
            sessionBytes += size;
            speedSamples.push({ ts: Date.now(), bytes: size });

            pendingDbWrites.push({
              key: `${job.id}::${fileSpec.path}`,
              jobId: job.id,
              path: fileSpec.path,
              blob,
              size,
              crc32,
            });
            pendingDbBytes += size;

            await flushCheckpoint(false);
            emitUi(false);
          } else if (res.status === 'cors_blocked') {
            corsSkippedSet.add(fileSpec.path);
            emitUi(false);
          } else if (res.status === 'missing') {
            // 404 on origin — mark handled so resume won't get stuck retrying nonexistent files
            completedSet.add(fileSpec.path);
            emitUi(false);
          } else {
            failedSet.add(fileSpec.path);
            consecutiveNetworkErrors++;
            emitUi(false);
            if (consecutiveNetworkErrors >= 12) {
              networkPaused = true;
              abortCtrl.abort();
              break;
            }
          }
        }
      };

      const workerCount = Math.min(concurrency, Math.max(1, pendingFiles.length));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await flushCheckpoint(true);
    } catch (err) {
      await flushCheckpoint(true);
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        job.status = 'error';
        job.pauseReason = 'network';
        job.statusMessage =
          err instanceof Error
            ? `Erro no download: ${err.message}. Você pode retomar de onde parou.`
            : 'Erro inesperado no download. Seu progresso foi salvo para retomar.';
        await saveBackupJobRecord(job);
        if (typeof window !== 'undefined') {
          window.removeEventListener('offline', onBrowserOffline);
        }
        params.onError({ ...job }, job.statusMessage);
        return;
      }
    } finally {
      if (typeof window !== 'undefined') {
        window.removeEventListener('offline', onBrowserOffline);
      }
    }

    if (userPaused || networkPaused || abortCtrl.signal.aborted) {
      job.status = 'paused';
      job.pauseReason = networkPaused ? 'network' : 'user';
      job.statusMessage = networkPaused
        ? 'Conexão instável ou offline — pausado automaticamente com progresso salvo. Retomará ao voltar a conexão.'
        : 'Download pausado — clique em "Retomar de onde parou" para continuar.';
      await saveBackupJobRecord(job);
      params.onPaused({ ...job });
      return;
    }

    // Check if ALL requested files were blocked by CORS (e.g., MP4/MP3 module on GitHub Pages without Custom CORS Proxy)
    if (completedSet.size === 0 && corsSkippedSet.size > 0) {
      job.status = 'paused';
      job.pauseReason = 'cors';
      job.statusMessage =
        'Este módulo contém arquivos MP4/MP3 bloqueados por CORS no GitHub Pages. Configure um Proxy CORS próprio (ex: Cloudflare Worker) ou rode o servidor local para baixar vídeos/áudios, e clique em Retomar.';
      await saveBackupJobRecord(job);
      params.onPaused({ ...job });
      return;
    }

    // All done -> Assemble zero-copy STORE ZIP64 & trigger download!
    job.status = 'assembling';
    job.statusMessage = 'Montando arquivo .ZIP em formato STORE (leitura instantânea)...';
    await saveBackupJobRecord(job);
    params.onProgress({
      job: { ...job },
      speedBytesPerSec: 0,
      etaSeconds: 0,
      currentFile: job.filename,
      assemblePercent: 5,
    });

    try {
      await assembleAndSaveBackupJobZip(job, params.ninjasForCatalog, (pct) => {
        params.onProgress({
          job: { ...job },
          speedBytesPerSec: 0,
          etaSeconds: 0,
          currentFile: job.filename,
          assemblePercent: pct,
        });
      });

      const skippedNote =
        corsSkippedSet.size > 0
          ? ` (${corsSkippedSet.size} MP4/MP3 ignorados sem Proxy CORS)`
          : '';
      const failedNote =
        failedSet.size > 0 ? ` (${failedSet.size} falhas — você pode tentar novamente)` : '';
      job.status = 'completed';
      job.pauseReason = null;
      job.statusMessage = `Backup "${job.filename}" baixado com sucesso!${skippedNote}${failedNote}`;
      await saveBackupJobRecord(job);
      params.onComplete({ ...job });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        job.status = 'paused';
        job.pauseReason = 'user';
        job.statusMessage =
          'Salvamento cancelado — os arquivos baixados continuam salvos em cache. Clique em "Salvar ZIP Agora".';
        await saveBackupJobRecord(job);
        params.onPaused({ ...job });
        return;
      }
      job.status = 'error';
      job.pauseReason = null;
      job.statusMessage =
        err instanceof Error
          ? `Erro ao montar o ZIP: ${err.message}. Clique em "Salvar ZIP Agora" para tentar novamente.`
          : 'Erro ao montar o arquivo ZIP. Seus dados continuam salvos para tentar novamente.';
      await saveBackupJobRecord(job);
      params.onError({ ...job }, job.statusMessage);
    }
  })();

  return { pause };
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${String(remM).padStart(2, '0')}m`;
}
