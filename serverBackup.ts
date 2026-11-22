import crypto from 'node:crypto';
import { once } from 'node:events';
import type express from 'express';
import { CHASE_SYSTEM_LEGEND } from './src/utils/combatMechanicsParser.ts';

export interface BackupNinjaEntry {
  id: string;
  code: string;
  name?: string;
  nameArtUrl?: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  atlasUrl: string;
  skeletonUrl: string;
  kind?: 'character' | 'summon_skin' | 'effect';
  sourceIndex?: 'spine-hd' | 'spine-astc' | 'code';
  hasVideo?: boolean;
}

export interface BackupExtractPayload {
  sourceUrl: string;
  resolvedGameUrl: string;
  gameTitle: string;
  ninjas: BackupNinjaEntry[];
  sheets: Array<{
    name: string;
    url: string;
    width?: number;
    height?: number;
    bytes?: number;
    sheetKind?: 'astc_sheet' | 'spine_sheet';
  }>;
  assets: Array<{
    name: string;
    url: string;
    category: string;
    ext: string;
  }>;
  stats: {
    scannedScripts: number;
    discoveredAssets: number;
    totalNinjas: number;
    totalSheets: number;
    elapsedMs: number;
  };
}

export interface BackupTablesLike {
  origin: string;
  fileSet: Set<string>;
  fileSizeByPath: Map<string, number>;
  fileByLower: Map<string, string>;
  heroVideoByLower: Map<string, string>;
  recruitVideoByLower: Map<string, string>;
  soundFileByLower: Map<string, string>;
  herois: Record<string, Record<string, unknown>>;
  pt: Record<string, unknown>;
  roleModels: Record<string, Record<string, unknown>>;
  skins: Record<string, Record<string, unknown>>;
  skills: Record<string, Record<string, unknown>>;
  sons: Record<string, string>;
}

export interface BackupRouteDeps {
  validatePublicUrl: (rawUrl: string) => Promise<URL>;
  isAllowedJotaHost: (origin: string) => boolean;
  loadJotaGameTables: (origin: string) => Promise<BackupTablesLike | null>;
  extractCatalogForUrl: (rawUrl: string) => Promise<BackupExtractPayload>;
  buildNinjaMediaProfileFromTables: (
    tables: BackupTablesLike,
    params: {
      ninjaId: string;
      code?: string;
      displayName?: string;
      requestedSounds?: string[];
      requestedVideos?: string[];
      requestedFeatures?: string[];
    }
  ) => Record<string, unknown>;
  fetchWithTimeout: (
    url: string,
    timeoutMs?: number,
    accept?: string,
    extraHeaders?: Record<string, string>
  ) => Promise<Response>;
  parseAtlasPageFilenames: (atlasText: string) => string[];
  resolveSoundUrlFromTables: (
    origin: string,
    soundKey: string,
    sons: Record<string, string>,
    fileSet?: Set<string>,
    soundFileByLower?: Map<string, string>
  ) => string | null;
}

export interface BackupModuleInfo {
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
}

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
const ARCHIVE_COMMENT = Buffer.from('SHINOBI_BACKUP_V1:STORE_ZERO_EXTRA', 'utf8');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()): { modTime: number; modDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const modTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const modDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { modTime, modDate };
}

interface NodeCentralRecord {
  nameBytes: Buffer;
  crc32: number;
  size: number;
  offset: number;
  modTime: number;
  modDate: number;
}

/**
 * Zero-RAM Node.js ZIP64 STORE (method 0) streaming writer.
 * Writes directly to an Express response with backpressure so multi-GB backups
 * stream to Android's native Download Manager without buffering in memory.
 * For files < 4 GB, local header extra length is always 0, allowing client-side
 * File.slice() direct offset calculation without extra disk seeks.
 */
class StreamingNodeZipWriter {
  private res: express.Response;
  private records: NodeCentralRecord[] = [];
  private offset = 0;
  private seenPaths = new Set<string>();
  private dosTime: { modTime: number; modDate: number };
  private finalizing = false;
  private closed = false;

  constructor(res: express.Response) {
    this.res = res;
    this.dosTime = getDosDateTime();
  }

  private async writeChunk(buf: Buffer): Promise<void> {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    if (!this.res.write(buf)) {
      await once(this.res, 'drain');
    }
  }

  hasPath(entryPath: string): boolean {
    return this.seenPaths.has(entryPath);
  }

  getEntryCount(): number {
    return this.records.length;
  }

  async addBuffer(rawPath: string, data: Buffer): Promise<void> {
    if (this.finalizing || this.closed || this.res.destroyed) return;
    const cleanPath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || cleanPath.includes('..') || this.seenPaths.has(cleanPath)) return;
    this.seenPaths.add(cleanPath);

    const nameBytes = Buffer.from(cleanPath, 'utf8');
    const size = data.length;
    const crc32 = computeCrc32(data);
    const { modTime, modDate } = this.dosTime;

    const needsZip64Local = size >= MAX_U32;
    const extraLen = needsZip64Local ? 20 : 0;
    const header = Buffer.allocUnsafe(30 + nameBytes.length + extraLen);

    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(needsZip64Local ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8
    header.writeUInt16LE(0, 8); // STORE
    header.writeUInt16LE(modTime, 10);
    header.writeUInt16LE(modDate, 12);
    header.writeUInt32LE(crc32 >>> 0, 14);
    header.writeUInt32LE(needsZip64Local ? MAX_U32 : size, 18);
    header.writeUInt32LE(needsZip64Local ? MAX_U32 : size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(extraLen, 28);
    nameBytes.copy(header, 30);

    if (needsZip64Local) {
      const extPos = 30 + nameBytes.length;
      header.writeUInt16LE(0x0001, extPos);
      header.writeUInt16LE(16, extPos + 2);
      header.writeBigUInt64LE(BigInt(size), extPos + 4);
      header.writeBigUInt64LE(BigInt(size), extPos + 12);
    }

    this.records.push({
      nameBytes,
      crc32,
      size,
      offset: this.offset,
      modTime,
      modDate,
    });

    await this.writeChunk(header);
    this.offset += header.length;

    if (size > 0) {
      await this.writeChunk(data);
      this.offset += size;
    }
  }

  async addJson(entryPath: string, payload: unknown): Promise<void> {
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    await this.addBuffer(entryPath, buf);
  }

  async finalize(): Promise<void> {
    if (this.finalizing || this.closed || this.res.destroyed) return;
    this.finalizing = true;

    const cdOffset = this.offset;
    let cdSize = 0;

    for (const rec of this.records) {
      const needsSize64 = rec.size >= MAX_U32;
      const needsOffset64 = rec.offset >= MAX_U32;
      const extraPayloadLen = (needsSize64 ? 16 : 0) + (needsOffset64 ? 8 : 0);
      const extraLen = extraPayloadLen > 0 ? 4 + extraPayloadLen : 0;

      const cdEntry = Buffer.allocUnsafe(46 + rec.nameBytes.length + extraLen);
      cdEntry.writeUInt32LE(0x02014b50, 0);
      cdEntry.writeUInt16LE(extraLen > 0 ? 45 : 20, 4);
      cdEntry.writeUInt16LE(extraLen > 0 ? 45 : 20, 6);
      cdEntry.writeUInt16LE(0x0800, 8);
      cdEntry.writeUInt16LE(0, 10); // STORE
      cdEntry.writeUInt16LE(rec.modTime, 12);
      cdEntry.writeUInt16LE(rec.modDate, 14);
      cdEntry.writeUInt32LE(rec.crc32 >>> 0, 16);
      cdEntry.writeUInt32LE(needsSize64 ? MAX_U32 : rec.size, 20);
      cdEntry.writeUInt32LE(needsSize64 ? MAX_U32 : rec.size, 24);
      cdEntry.writeUInt16LE(rec.nameBytes.length, 28);
      cdEntry.writeUInt16LE(extraLen, 30);
      cdEntry.writeUInt16LE(0, 32);
      cdEntry.writeUInt16LE(0, 34);
      cdEntry.writeUInt16LE(0, 36);
      cdEntry.writeUInt32LE(0, 38);
      cdEntry.writeUInt32LE(needsOffset64 ? MAX_U32 : rec.offset, 42);
      rec.nameBytes.copy(cdEntry, 46);

      if (extraLen > 0) {
        let extPos = 46 + rec.nameBytes.length;
        cdEntry.writeUInt16LE(0x0001, extPos);
        cdEntry.writeUInt16LE(extraPayloadLen, extPos + 2);
        extPos += 4;
        if (needsSize64) {
          cdEntry.writeBigUInt64LE(BigInt(rec.size), extPos);
          cdEntry.writeBigUInt64LE(BigInt(rec.size), extPos + 8);
          extPos += 16;
        }
        if (needsOffset64) {
          cdEntry.writeBigUInt64LE(BigInt(rec.offset), extPos);
        }
      }

      await this.writeChunk(cdEntry);
      cdSize += cdEntry.length;
    }

    const count = this.records.length;
    const needsZip64Eocd = count >= MAX_U16 || cdSize >= MAX_U32 || cdOffset >= MAX_U32;
    if (needsZip64Eocd) {
      const zip64EocdOffset = cdOffset + cdSize;
      const z64 = Buffer.allocUnsafe(56);
      z64.writeUInt32LE(0x06064b50, 0);
      z64.writeBigUInt64LE(44n, 4);
      z64.writeUInt16LE(45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(count), 24);
      z64.writeBigUInt64LE(BigInt(count), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdOffset), 48);
      await this.writeChunk(z64);

      const loc = Buffer.allocUnsafe(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.writeChunk(loc);
    }

    const eocd = Buffer.allocUnsafe(22 + ARCHIVE_COMMENT.length);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count >= MAX_U16 ? MAX_U16 : count, 8);
    eocd.writeUInt16LE(count >= MAX_U16 ? MAX_U16 : count, 10);
    eocd.writeUInt32LE(cdSize >= MAX_U32 ? MAX_U32 : cdSize, 12);
    eocd.writeUInt32LE(cdOffset >= MAX_U32 ? MAX_U32 : cdOffset, 16);
    eocd.writeUInt16LE(ARCHIVE_COMMENT.length, 20);
    ARCHIVE_COMMENT.copy(eocd, 22);
    await this.writeChunk(eocd);
    this.closed = true;

    this.res.end();
  }
}

function urlToSafeRelPath(urlStr: string, expectedOrigin: string): string | null {
  try {
    const parsed = new URL(urlStr);
    if (parsed.origin !== expectedOrigin) return null;
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('\\') || /[\x00-\x1f]/.test(rel)) {
      return null;
    }
    return rel;
  } catch {
    return null;
  }
}

function sanitizeFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120) || 'shinobi_backup.zip';
}

function partitionFilesBySize(
  paths: string[],
  sizeMap: Map<string, number>,
  maxBytesPerPart: number
): Array<{ files: string[]; bytes: number }> {
  const parts: Array<{ files: string[]; bytes: number }> = [];
  let currentFiles: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const sz = sizeMap.get(p) || 0;
    if (currentFiles.length > 0 && currentBytes + sz > maxBytesPerPart) {
      parts.push({ files: currentFiles, bytes: currentBytes });
      currentFiles = [];
      currentBytes = 0;
    }
    currentFiles.push(p);
    currentBytes += sz;
  }
  if (currentFiles.length > 0) {
    parts.push({ files: currentFiles, bytes: currentBytes });
  }
  return parts;
}

interface ComputedBackupSets {
  baseFiles: string[];
  videoFiles: string[];
  audioFiles: string[];
  particleParts: Array<{ files: string[]; bytes: number }>;
  spriteParts: Array<{ files: string[]; bytes: number }>;
  assetParts: Array<{ files: string[]; bytes: number }>;
  modules: BackupModuleInfo[];
  completeFileCount: number;
  completeEstimatedBytes: number;
}

function computeBackupFileSets(
  catalog: BackupExtractPayload,
  tables: BackupTablesLike
): ComputedBackupSets {
  const origin = tables.origin;
  const { fileSet, fileSizeByPath } = tables;

  // 1. Base: all catalog .atlas + .json + spine-no-estados + nameArt
  const baseSet = new Set<string>();

  for (const n of catalog.ninjas) {
    const atlasRel = urlToSafeRelPath(n.atlasUrl, origin);
    const skelRel = urlToSafeRelPath(n.skeletonUrl, origin);
    if (atlasRel && (fileSet.size === 0 || fileSet.has(atlasRel))) baseSet.add(atlasRel);
    if (skelRel && (fileSet.size === 0 || fileSet.has(skelRel))) baseSet.add(skelRel);
    if (n.nameArtUrl) {
      const artRel = urlToSafeRelPath(n.nameArtUrl, origin);
      if (artRel && (fileSet.size === 0 || fileSet.has(artRel))) baseSet.add(artRel);
    }
  }

  // Passive idle auras (Susano'o armors, etc.) and skill/passive icons -> always in Base
  for (const rel of fileSet) {
    const low = rel.toLowerCase();
    if (
      rel.startsWith('acervo/asset/spine-no-estados/') ||
      ((rel.startsWith('acervo/asset/items/skill_') || rel.startsWith('acervo/asset/ui/icon/')) &&
        (low.endsWith('.png') || low.endsWith('.webp')))
    ) {
      baseSet.add(rel);
    }
  }

  // 2. Videos (hero + recruit MP4)
  const videoFiles: string[] = [];
  for (const rel of fileSet) {
    if (
      (rel.startsWith('acervo/video/hero/') || rel.startsWith('acervo/video/recruit/')) &&
      rel.toLowerCase().endsWith('.mp4')
    ) {
      videoFiles.push(rel);
    }
  }
  videoFiles.sort();

  // 3. Audios (all MP3 voices & SFX)
  const audioFiles: string[] = [];
  for (const rel of fileSet) {
    if (rel.startsWith('acervo/som/') && rel.toLowerCase().endsWith('.mp3')) {
      audioFiles.push(rel);
    }
  }
  audioFiles.sort();

  // 4. Particles (noe_* + efeito_* + *_effect / *_highteffect / *_ground in acervo/asset/spine/)
  const particleSet = new Set<string>();
  for (const rel of fileSet) {
    if (!rel.startsWith('acervo/asset/spine/')) continue;
    const fname = rel.slice('acervo/asset/spine/'.length);
    const lower = fname.toLowerCase();
    if (
      lower.startsWith('noe_') ||
      lower.startsWith('efeito_') ||
      /_effect\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower) ||
      /_highteffect\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower) ||
      /_ground\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower)
    ) {
      if (!baseSet.has(rel)) {
        particleSet.add(rel);
      }
    }
  }
  const particleFiles = Array.from(particleSet).sort();

  // 5. Sprite sheets (all remaining .webp/.png/.jpg textures in acervo/asset/spine/ + catalog.sheets)
  const spriteSet = new Set<string>();
  for (const s of catalog.sheets) {
    const rel = urlToSafeRelPath(s.url, origin);
    if (rel && !baseSet.has(rel) && !particleSet.has(rel)) {
      spriteSet.add(rel);
    }
  }
  for (const rel of fileSet) {
    if (!rel.startsWith('acervo/asset/spine/')) continue;
    if (baseSet.has(rel) || particleSet.has(rel)) continue;
    const fname = rel.slice('acervo/asset/spine/'.length);
    const lower = fname.toLowerCase();
    if (!/\.(webp|png|jpe?g)$/i.test(lower)) continue;
    spriteSet.add(rel);
  }
  const spriteFiles = Array.from(spriteSet).sort();

  // 6. Optional extra UI/Emojis/Items & Skill Icons assets
  const assetSet = new Set<string>();
  for (const a of catalog.assets) {
    const rel = urlToSafeRelPath(a.url, origin);
    if (
      rel &&
      !baseSet.has(rel) &&
      !particleSet.has(rel) &&
      !spriteSet.has(rel) &&
      (fileSet.size === 0 || fileSet.has(rel))
    ) {
      assetSet.add(rel);
    }
  }
  for (const rel of fileSet) {
    if (
      rel.startsWith('acervo/asset/items/skill_') &&
      rel.toLowerCase().endsWith('.png') &&
      !baseSet.has(rel) &&
      !particleSet.has(rel) &&
      !spriteSet.has(rel)
    ) {
      assetSet.add(rel);
    }
  }
  const assetFiles = Array.from(assetSet).sort();

  const sumBytes = (list: string[]) =>
    list.reduce((acc, p) => acc + (fileSizeByPath.get(p) || 0), 0);

  const baseFiles = Array.from(baseSet).sort();
  // Reserve ~3 MB estimate for _shinobi_backup/{catalog,media-profiles,sons,meta}.json
  const baseBytes = sumBytes(baseFiles) + 3 * 1024 * 1024;
  const videoBytes = sumBytes(videoFiles);
  const audioBytes = sumBytes(audioFiles);

  const particleParts = partitionFilesBySize(particleFiles, fileSizeByPath, 250 * 1024 * 1024);
  const spriteParts = partitionFilesBySize(spriteFiles, fileSizeByPath, 300 * 1024 * 1024);
  const assetParts = partitionFilesBySize(assetFiles, fileSizeByPath, 280 * 1024 * 1024);

  const modules: BackupModuleInfo[] = [
    {
      id: 'base-1',
      module: 'base',
      part: 1,
      totalParts: 1,
      label: '01. Base: Catálogo, Esqueletos, Auras e Ícones',
      description:
        'Obrigatório: catálogo completo, habilidades e mecânicas de combate, ícones das skills, esqueletos .atlas/.json, auras passivas e artes de nome.',
      filename: '01_shinobi_base_catalogo_esqueletos.zip',
      fileCount: baseFiles.length + 5,
      estimatedBytes: baseBytes,
      recommended: true,
    },
    {
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
    },
    {
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
    },
  ];

  particleParts.forEach((p, idx) => {
    const partNum = idx + 1;
    modules.push({
      id: `particles-${partNum}`,
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
    modules.push({
      id: `sprites-${partNum}`,
      module: 'sprites',
      part: partNum,
      totalParts: spriteParts.length,
      label:
        spriteParts.length > 1
          ? `05. Folhas de Sprites dos Ninjas (Parte ${partNum}/${spriteParts.length})`
          : '05. Folhas de Sprites dos Ninjas',
      description:
        'Texturas WebP/PNG usadas pelos esqueletos Spine para renderizar os personagens, invocações e skins.',
      filename: `05_shinobi_sprites_p${partNum}_de_${spriteParts.length}.zip`,
      fileCount: p.files.length + 1,
      estimatedBytes: p.bytes,
      recommended: true,
    });
  });

  assetParts.forEach((p, idx) => {
    const partNum = idx + 1;
    modules.push({
      id: `assets-${partNum}`,
      module: 'assets',
      part: partNum,
      totalParts: assetParts.length,
      label:
        assetParts.length > 1
          ? `06. Opcional: Emojis, UI, Itens e Cenários (Parte ${partNum}/${assetParts.length})`
          : '06. Opcional: Emojis, UI, Itens e Cenários',
      description: 'Ativos extras exibidos na aba "Outros Ativos" (não obrigatórios para o Estúdio Spine).',
      filename: `06_shinobi_ativos_ui_p${partNum}_de_${assetParts.length}.zip`,
      fileCount: p.files.length + 1,
      estimatedBytes: p.bytes,
      recommended: false,
    });
  });

  const completeFileCount =
    baseFiles.length +
    5 +
    videoFiles.length +
    audioFiles.length +
    particleFiles.length +
    spriteFiles.length +
    assetFiles.length;
  const completeEstimatedBytes =
    baseBytes +
    videoBytes +
    audioBytes +
    particleParts.reduce((a, p) => a + p.bytes, 0) +
    spriteParts.reduce((a, p) => a + p.bytes, 0) +
    assetParts.reduce((a, p) => a + p.bytes, 0);

  return {
    baseFiles,
    videoFiles,
    audioFiles,
    particleParts,
    spriteParts,
    assetParts,
    modules,
    completeFileCount,
    completeEstimatedBytes,
  };
}

function extractEffectIdsAndAudioFromSkeletonServer(skeleton: unknown): {
  effectIds: Set<string>;
  soundNames: Set<string>;
  videoNames: Set<string>;
  featureFiles: Set<string>;
} {
  const effectIds = new Set<string>();
  const soundNames = new Set<string>();
  const videoNames = new Set<string>();
  const featureFiles = new Set<string>();

  if (!skeleton || typeof skeleton !== 'object') {
    return { effectIds, soundNames, videoNames, featureFiles };
  }
  const anims = (skeleton as { animations?: Record<string, unknown> }).animations;
  if (!anims || typeof anims !== 'object') {
    return { effectIds, soundNames, videoNames, featureFiles };
  }

  for (const animData of Object.values(anims)) {
    const events = (animData as { events?: Array<{ name?: string; string?: string }> })?.events;
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (typeof ev.string === 'string' && ev.string.length > 0) {
        const cmd = ev.string;
        // {DISPLAY:spine="noe_...",...}, {DISPLAYTARGET:spine="noe_...",...}, or {PLAYEFFECT:...}
        for (const m of cmd.matchAll(/\{([A-Za-z0-9_]+):([^}]+)\}/g)) {
          const cmdType = m[1].toUpperCase();
          const body = m[2];
          if (cmdType.startsWith('DISPLAY') || cmdType.includes('EFFECT')) {
            const spMatch = body.match(/spine\s*=\s*(?:["']([^"']+)["']|([^,\s}]+))/i);
            if (spMatch) {
              const sp = (spMatch[1] || spMatch[2] || '').trim();
              if (sp) effectIds.add(sp);
            }
          } else if (cmdType.includes('SOUND')) {
            const sMatch = body.match(/(?:name|sound|source|file)\s*=\s*(?:["']([^"']+)["']|([^,\s}]+))/i);
            if (sMatch) {
              const sn = (sMatch[1] || sMatch[2] || '').trim();
              if (sn) soundNames.add(sn);
            }
          } else if (/^PLAYV(?:E|I)D(?:E|I)O$/i.test(cmdType)) {
            const vMatch = body.match(/source\s*=\s*(?:["']([^"']+)["']|([^,\s}]+))/i);
            if (vMatch) {
              const vn = (vMatch[1] || vMatch[2] || '').trim();
              if (vn) {
                videoNames.add(vn);
                const careMatch = body.match(/careforward\s*=\s*["']?([^"',\s}]+)["']?/i);
                const careVal = (careMatch?.[1] || '').toLowerCase();
                if (careVal === '1' || careVal === 'true') {
                  videoNames.add(`${vn}_left`);
                }
              }
            }
          } else if (cmdType === 'SHOWFEATURE') {
            for (const fm of body.matchAll(/file\s*=\s*["']([^"']+)["']/gi)) {
              const f = fm[1].trim();
              if (f) featureFiles.add(f);
            }
          }
        }
      }

      // Direct Spine event names (yy_*, atk_*, electric_*, etc.)
      const rawName = (ev.name || '').trim();
      if (
        rawName &&
        rawName !== '@CMD' &&
        rawName.toLowerCase() !== 'label' &&
        !rawName.toLowerCase().startsWith('no:') &&
        !rawName.startsWith('{') &&
        /^[A-Za-z0-9_/-]+$/.test(rawName)
      ) {
        soundNames.add(rawName);
      }
    }
  }

  return { effectIds, soundNames, videoNames, featureFiles };
}

async function fetchBufferWithRetry(
  url: string,
  fetchWithTimeout: BackupRouteDeps['fetchWithTimeout'],
  signal: AbortSignal,
  timeoutMs = 20000
): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return null;
    try {
      const resp = await fetchWithTimeout(url, timeoutMs, '*/*');
      if (resp.status === 404 || resp.status === 403) return null;
      if (!resp.ok) {
        if (attempt === 0) continue;
        return null;
      }
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    } catch {
      if (signal.aborted) return null;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  return null;
}

async function streamRemotePathsToZip(
  zip: StreamingNodeZipWriter,
  origin: string,
  relPaths: string[],
  fetchWithTimeout: BackupRouteDeps['fetchWithTimeout'],
  signal: AbortSignal,
  concurrency = 16
): Promise<void> {
  const uniquePaths = Array.from(new Set(relPaths)).filter((p) => p && !zip.hasPath(p));
  if (uniquePaths.length === 0) return;

  // Sliding-window parallel fetcher: keeps up to `concurrency` downloads active
  // without stalling on slow files, while writing into the ZIP stream sequentially.
  let nextIdx = 0;
  let writeChain = Promise.resolve();
  const workerCount = Math.min(Math.max(1, concurrency), uniquePaths.length);

  const runWorker = async () => {
    while (!signal.aborted) {
      const idx = nextIdx++;
      if (idx >= uniquePaths.length) break;
      const rel = uniquePaths[idx];
      const url = `${origin}/${rel.replace(/^\/+/, '')}`;
      const buf = await fetchBufferWithRetry(url, fetchWithTimeout, signal);
      if (signal.aborted || !buf || buf.length === 0) continue;
      writeChain = writeChain.then(() => {
        if (signal.aborted) return;
        return zip.addBuffer(rel, buf);
      });
      await writeChain;
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  await writeChain;
}

interface CustomBackupTokenEntry {
  createdAt: number;
  url: string;
  ninjaIds: string[];
  includeParticles: boolean;
  includeVideos: boolean;
  includeAudio: boolean;
  includeNameArt: boolean;
  filename: string;
  label: string;
}

const customBackupTokens = new Map<string, CustomBackupTokenEntry>();

function pruneExpiredTokens() {
  const now = Date.now();
  for (const [k, v] of customBackupTokens.entries()) {
    if (now - v.createdAt > 15 * 60 * 1000) {
      customBackupTokens.delete(k);
    }
  }
  while (customBackupTokens.size > 40) {
    const oldest = customBackupTokens.keys().next().value;
    if (!oldest) break;
    customBackupTokens.delete(oldest);
  }
}

export function registerBackupRoutes(app: express.Express, deps: BackupRouteDeps) {
  async function resolveValidatedOriginAndData(rawUrl: string): Promise<{
    origin: string;
    catalog: BackupExtractPayload;
    tables: BackupTablesLike;
  }> {
    const safeUrl = rawUrl.trim() || 'https://naruto.jotagame.com/';
    const parsed = await deps.validatePublicUrl(safeUrl);
    if (!deps.isAllowedJotaHost(parsed.origin)) {
      throw new Error('Backup offline completo está disponível apenas para servidores de jogo suportados.');
    }
    const [catalog, tables] = await Promise.all([
      deps.extractCatalogForUrl(parsed.toString()),
      deps.loadJotaGameTables(parsed.origin),
    ]);
    if (!tables) {
      throw new Error('Não foi possível carregar o manifesto de arquivos do servidor do jogo.');
    }
    return { origin: tables.origin, catalog, tables };
  }

  function buildMediaProfilesMap(
    catalogNinjas: BackupNinjaEntry[],
    tables: BackupTablesLike,
    extrasByNinjaId?: Map<
      string,
      { sounds?: string[]; videos?: string[]; features?: string[] }
    >
  ): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const n of catalogNinjas) {
      const ex = extrasByNinjaId?.get(n.id);
      out[n.id] = deps.buildNinjaMediaProfileFromTables(tables, {
        ninjaId: n.id,
        code: n.code,
        displayName: n.name,
        requestedSounds: ex?.sounds,
        requestedVideos: ex?.videos,
        requestedFeatures: ex?.features,
      });
    }
    return out;
  }

  async function streamCustomStandaloneBackup(
    req: express.Request,
    res: express.Response,
    cfg: {
      url: string;
      ninjaIds: string[];
      includeParticles: boolean;
      includeVideos: boolean;
      includeAudio: boolean;
      includeNameArt: boolean;
      filename: string;
      label: string;
      moduleId: string;
    }
  ) {
    const abortCtrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortCtrl.abort();
      }
    });

    const { origin, catalog, tables } = await resolveValidatedOriginAndData(cfg.url);
    const idSet = new Set(cfg.ninjaIds);
    const selectedNinjas = catalog.ninjas.filter((n) => idSet.has(n.id));
    if (selectedNinjas.length === 0) {
      res.status(400).json({ error: 'Nenhum ninja válido selecionado para o backup.' });
      return;
    }

    const safeFile = sanitizeFilename(cfg.filename);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const zip = new StreamingNodeZipWriter(res);

    const extraPathsToStream = new Set<string>();
    const effectSpineIds = new Set<string>();
    const extrasByNinjaId = new Map<
      string,
      { sounds: string[]; videos: string[]; features: string[] }
    >();

    // Phase 1: Fetch selected ninjas' .atlas & .json, write them straight into the ZIP,
    // and collect exact sprite sheets, particles, sounds, videos, and nameArt.
    for (let i = 0; i < selectedNinjas.length; i += 6) {
      if (abortCtrl.signal.aborted) return;
      const batch = selectedNinjas.slice(i, i + 6);
      const batchResults = await Promise.all(
        batch.map(async (ninja) => {
          const atlasRel = urlToSafeRelPath(ninja.atlasUrl, origin);
          const skelRel = urlToSafeRelPath(ninja.skeletonUrl, origin);
          const [atlasBuf, skelBuf] = await Promise.all([
            atlasRel
              ? fetchBufferWithRetry(`${origin}/${atlasRel}`, deps.fetchWithTimeout, abortCtrl.signal)
              : Promise.resolve(null),
            skelRel
              ? fetchBufferWithRetry(`${origin}/${skelRel}`, deps.fetchWithTimeout, abortCtrl.signal)
              : Promise.resolve(null),
          ]);
          return { ninja, atlasRel, skelRel, atlasBuf, skelBuf };
        })
      );

      for (const item of batchResults) {
        if (abortCtrl.signal.aborted) return;
        const { ninja, atlasRel, skelRel, atlasBuf, skelBuf } = item;

        if (atlasRel && atlasBuf) {
          await zip.addBuffer(atlasRel, atlasBuf);
          const atlasText = atlasBuf.toString('utf8');
          const pages = deps.parseAtlasPageFilenames(atlasText);
          for (const page of pages) {
            try {
              const resolved = new URL(page, ninja.atlasUrl).toString();
              const pageRel = urlToSafeRelPath(resolved, origin);
              if (pageRel) extraPathsToStream.add(pageRel);
            } catch {
              // ignore malformed page ref
            }
          }
        }

        if (skelRel && skelBuf) {
          await zip.addBuffer(skelRel, skelBuf);
          try {
            const skelJson = JSON.parse(skelBuf.toString('utf8')) as unknown;
            const parsed = extractEffectIdsAndAudioFromSkeletonServer(skelJson);
            if (cfg.includeParticles) {
              for (const eid of parsed.effectIds) effectSpineIds.add(eid);
            }
            extrasByNinjaId.set(ninja.id, {
              sounds: Array.from(parsed.soundNames),
              videos: Array.from(parsed.videoNames),
              features: Array.from(parsed.featureFiles),
            });
          } catch {
            // ignore malformed skeleton json
          }
        }

        if (cfg.includeNameArt && ninja.nameArtUrl) {
          const artRel = urlToSafeRelPath(ninja.nameArtUrl, origin);
          if (artRel) extraPathsToStream.add(artRel);
        }
      }
    }

    if (abortCtrl.signal.aborted) return;

    // Build exact precomputed media profiles & filtered catalog
    const mediaProfiles = buildMediaProfilesMap(selectedNinjas, tables, extrasByNinjaId);
    const filteredCatalog: BackupExtractPayload = {
      ...catalog,
      ninjas: selectedNinjas,
      sheets: [],
      assets: [],
      stats: {
        ...catalog.stats,
        totalNinjas: selectedNinjas.length,
        totalSheets: 0,
        discoveredAssets: 0,
      },
    };

    // Collect passive auras, videos, and audio files referenced by media profiles
    const passiveAuraPackages: Array<{ atlasUrl: string; skeletonUrl: string }> = [];
    const seenAuraAtlas = new Set<string>();

    for (const profile of Object.values(mediaProfiles)) {
      const aura = profile.passiveAura as
        | { atlasUrl?: string; skeletonUrl?: string }
        | null
        | undefined;
      if (cfg.includeParticles && aura?.atlasUrl && !seenAuraAtlas.has(aura.atlasUrl)) {
        seenAuraAtlas.add(aura.atlasUrl);
        passiveAuraPackages.push({
          atlasUrl: aura.atlasUrl,
          skeletonUrl: aura.skeletonUrl || '',
        });
      }

      if (cfg.includeVideos) {
        const videos = (profile.videos as Array<{ url?: string }>) || [];
        for (const v of videos) {
          if (v.url) {
            const rel = urlToSafeRelPath(v.url, origin);
            if (rel) extraPathsToStream.add(rel);
          }
        }
      }

      // Always include skill & passive icons for standalone backups
      const skillsObj = (profile.skills as Record<string, { iconUrl?: string }>) || {};
      for (const sk of Object.values(skillsObj)) {
        if (sk?.iconUrl) {
          const rel = urlToSafeRelPath(sk.iconUrl, origin);
          if (rel) extraPathsToStream.add(rel);
        }
      }
      const passivesArr = (profile.passives as Array<{ iconUrl?: string }>) || [];
      for (const pas of passivesArr) {
        if (pas?.iconUrl) {
          const rel = urlToSafeRelPath(pas.iconUrl, origin);
          if (rel) extraPathsToStream.add(rel);
        }
      }

      if (cfg.includeAudio) {
        const voices = (profile.voices as Array<{ url?: string }>) || [];
        for (const v of voices) {
          if (v.url) {
            const rel = urlToSafeRelPath(v.url, origin);
            if (rel) extraPathsToStream.add(rel);
          }
        }
        const soundUrlMap = (profile.soundUrlMap as Record<string, string>) || {};
        for (const sUrl of Object.values(soundUrlMap)) {
          const rel = urlToSafeRelPath(sUrl, origin);
          if (rel) extraPathsToStream.add(rel);
        }
      }
    }

    // Write backup metadata, catalog, media-profiles & sons map
    await zip.addJson('_shinobi_backup/meta.json', {
      format: 'shinobi-backup-v1',
      createdAt: new Date().toISOString(),
      origin,
      moduleId: cfg.moduleId,
      label: cfg.label,
      storeZeroExtra: true,
      ninjaCount: selectedNinjas.length,
    });
    await zip.addJson('_shinobi_backup/catalog.json', filteredCatalog);
    await zip.addJson('_shinobi_backup/media-profiles.json', mediaProfiles);
    await zip.addJson('_shinobi_backup/sons.json', tables.sons);
    await zip.addJson('_shinobi_backup/combate_e_habilidades.json', {
      schemaVersion: 'shinobi-combat-v1',
      generatedAt: new Date().toISOString(),
      origin,
      chaseSystemLegend: CHASE_SYSTEM_LEGEND,
      totalNinjas: Object.keys(mediaProfiles).length,
      ninjas: Object.fromEntries(
        Object.entries(mediaProfiles).map(([id, prof]) => {
          const p = prof as Record<string, unknown>;
          return [
            id,
            {
              ninjaId: id,
              heroCode: p.heroCode,
              displayName: p.displayName,
              combatProfile: p.combatProfile,
              skills: p.skills,
              passives: p.passives,
            },
          ];
        })
      ),
    });

    // Phase 2: Fetch linked particle Spine packages (noe_*) & passive auras, parse THEIR atlas pages too!
    if (cfg.includeParticles) {
      const particleTargets: Array<{ atlasUrl: string; skeletonUrl: string }> = [
        ...passiveAuraPackages,
      ];
      for (const eid of effectSpineIds) {
        if (!/^[a-zA-Z0-9._-]{1,120}$/.test(eid)) continue;
        particleTargets.push({
          atlasUrl: `${origin}/acervo/asset/spine/${eid}.atlas`,
          skeletonUrl: `${origin}/acervo/asset/spine/${eid}.json`,
        });
      }

      for (let i = 0; i < particleTargets.length; i += 6) {
        if (abortCtrl.signal.aborted) return;
        const batch = particleTargets.slice(i, i + 6);
        const resBatch = await Promise.all(
          batch.map(async (pt) => {
            const atlasRel = urlToSafeRelPath(pt.atlasUrl, origin);
            const skelRel = urlToSafeRelPath(pt.skeletonUrl, origin);
            const [atlasBuf, skelBuf] = await Promise.all([
              atlasRel
                ? fetchBufferWithRetry(`${origin}/${atlasRel}`, deps.fetchWithTimeout, abortCtrl.signal)
                : Promise.resolve(null),
              skelRel
                ? fetchBufferWithRetry(`${origin}/${skelRel}`, deps.fetchWithTimeout, abortCtrl.signal)
                : Promise.resolve(null),
            ]);
            return { pt, atlasRel, skelRel, atlasBuf, skelBuf };
          })
        );
        for (const item of resBatch) {
          if (abortCtrl.signal.aborted) return;
          if (item.atlasRel && item.atlasBuf) {
            await zip.addBuffer(item.atlasRel, item.atlasBuf);
            const pages = deps.parseAtlasPageFilenames(item.atlasBuf.toString('utf8'));
            for (const page of pages) {
              try {
                const resolved = new URL(page, item.pt.atlasUrl).toString();
                const pageRel = urlToSafeRelPath(resolved, origin);
                if (pageRel) extraPathsToStream.add(pageRel);
              } catch {
                // ignore
              }
            }
          }
          if (item.skelRel && item.skelBuf) {
            await zip.addBuffer(item.skelRel, item.skelBuf);
          }
        }
      }
    }

    // Phase 3: Stream all collected sprite sheets, particle sheets, nameArt, MP4 videos & MP3 audios!
    await streamRemotePathsToZip(
      zip,
      origin,
      Array.from(extraPathsToStream).sort(),
      deps.fetchWithTimeout,
      abortCtrl.signal,
      16
    );

    if (!abortCtrl.signal.aborted) {
      await zip.finalize();
    }
  }

  // 1. Plan endpoint: returns exact modular sizes & file counts
  app.get('/api/backup/plan', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : 'https://naruto.jotagame.com/';
      const { origin, catalog, tables } = await resolveValidatedOriginAndData(rawUrl);
      const sets = computeBackupFileSets(catalog, tables);
      const mp4Ninjas = catalog.ninjas.filter((n) => n.hasVideo);

      res.json({
        origin,
        gameTitle: catalog.gameTitle,
        totalCatalogNinjas: catalog.ninjas.length,
        mp4NinjaCount: mp4Ninjas.length,
        modules: sets.modules,
        completeFileCount: sets.completeFileCount,
        completeEstimatedBytes: sets.completeEstimatedBytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao calcular plano de backup offline.';
      res.status(400).json({ error: msg });
    }
  });

  // 2. Streaming download for standard modules, parts, complete archive, or mp4_ninjas preset
  app.get('/api/backup/download', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : 'https://naruto.jotagame.com/';
      const moduleName = typeof req.query.module === 'string' ? req.query.module.trim() : '';
      const partNum = Math.max(1, Math.floor(Number(req.query.part) || 1));

      const allowedModules = new Set([
        'base',
        'videos',
        'audios',
        'particles',
        'sprites',
        'assets',
        'complete',
        'mp4_ninjas',
      ]);
      if (!allowedModules.has(moduleName)) {
        res.status(400).json({ error: 'Módulo de backup inválido.' });
        return;
      }

      if (moduleName === 'mp4_ninjas') {
        const { catalog } = await resolveValidatedOriginAndData(rawUrl);
        const mp4Ids = catalog.ninjas.filter((n) => n.hasVideo).map((n) => n.id);
        await streamCustomStandaloneBackup(req, res, {
          url: rawUrl,
          ninjaIds: mp4Ids,
          includeParticles: true,
          includeVideos: true,
          includeAudio: true,
          includeNameArt: true,
          filename: `shinobi_backup_${mp4Ids.length}_ninjas_com_mp4.zip`,
          label: `Backup Autocontido (${mp4Ids.length} Ninjas com Vídeo MP4)`,
          moduleId: 'mp4_ninjas',
        });
        return;
      }

      const abortCtrl = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortCtrl.abort();
        }
      });

      const { origin, catalog, tables } = await resolveValidatedOriginAndData(rawUrl);
      const sets = computeBackupFileSets(catalog, tables);

      let filename = 'shinobi_backup.zip';
      let label = 'Backup Offline';
      let includeCatalogJson = false;
      let filesToStream: string[] = [];

      if (moduleName === 'base') {
        filename = '01_shinobi_base_catalogo_esqueletos.zip';
        label = 'Base: Catálogo, Tabelas, Esqueletos, Auras e Nomes';
        includeCatalogJson = true;
        filesToStream = sets.baseFiles;
      } else if (moduleName === 'videos') {
        filename = '02_shinobi_videos_mp4.zip';
        label = 'Vídeos MP4 (Ultimates e Apresentação)';
        filesToStream = sets.videoFiles;
      } else if (moduleName === 'audios') {
        filename = '03_shinobi_audios_vozes_mp3.zip';
        label = 'Áudios e Vozes MP3';
        filesToStream = sets.audioFiles;
      } else if (moduleName === 'particles') {
        const idx = partNum - 1;
        if (idx < 0 || idx >= sets.particleParts.length) {
          res.status(400).json({ error: 'Parte de partículas fora do intervalo.' });
          return;
        }
        filename = `04_shinobi_particulas_p${partNum}_de_${sets.particleParts.length}.zip`;
        label = `Partículas e Efeitos (Parte ${partNum}/${sets.particleParts.length})`;
        filesToStream = sets.particleParts[idx].files;
      } else if (moduleName === 'sprites') {
        const idx = partNum - 1;
        if (idx < 0 || idx >= sets.spriteParts.length) {
          res.status(400).json({ error: 'Parte de sprites fora do intervalo.' });
          return;
        }
        filename = `05_shinobi_sprites_p${partNum}_de_${sets.spriteParts.length}.zip`;
        label = `Folhas de Sprites (Parte ${partNum}/${sets.spriteParts.length})`;
        filesToStream = sets.spriteParts[idx].files;
      } else if (moduleName === 'assets') {
        const idx = partNum - 1;
        if (idx < 0 || idx >= sets.assetParts.length) {
          res.status(400).json({ error: 'Parte de ativos extras fora do intervalo.' });
          return;
        }
        filename = `06_shinobi_ativos_ui_p${partNum}_de_${sets.assetParts.length}.zip`;
        label = `Outros Ativos UI/Emojis (Parte ${partNum}/${sets.assetParts.length})`;
        filesToStream = sets.assetParts[idx].files;
      } else if (moduleName === 'complete') {
        filename = 'shinobi_backup_completo_tudo.zip';
        label = 'Backup Completo (Tudo em 1 ZIP: Sprites, Ícones, Partículas, Vídeos, Áudios e Ativos)';
        includeCatalogJson = true;
        filesToStream = [
          ...sets.baseFiles,
          ...sets.videoFiles,
          ...sets.audioFiles,
          ...sets.particleParts.flatMap((p) => p.files),
          ...sets.spriteParts.flatMap((p) => p.files),
          ...sets.assetParts.flatMap((p) => p.files),
        ];
      }

      const safeFile = sanitizeFilename(filename);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const zip = new StreamingNodeZipWriter(res);

      await zip.addJson('_shinobi_backup/meta.json', {
        format: 'shinobi-backup-v1',
        createdAt: new Date().toISOString(),
        origin,
        moduleId: moduleName === 'particles' || moduleName === 'sprites' || moduleName === 'assets'
          ? `${moduleName}-${partNum}`
          : moduleName,
        label,
        storeZeroExtra: true,
        expectedFiles: filesToStream.length,
      });

      if (includeCatalogJson) {
        const mediaProfiles = buildMediaProfilesMap(catalog.ninjas, tables);
        await zip.addJson('_shinobi_backup/catalog.json', catalog);
        await zip.addJson('_shinobi_backup/media-profiles.json', mediaProfiles);
        await zip.addJson('_shinobi_backup/sons.json', tables.sons);
        await zip.addJson('_shinobi_backup/combate_e_habilidades.json', {
          schemaVersion: 'shinobi-combat-v1',
          generatedAt: new Date().toISOString(),
          origin,
          chaseSystemLegend: CHASE_SYSTEM_LEGEND,
          totalNinjas: Object.keys(mediaProfiles).length,
          ninjas: Object.fromEntries(
            Object.entries(mediaProfiles).map(([id, prof]) => {
              const p = prof as Record<string, unknown>;
              return [
                id,
                {
                  ninjaId: id,
                  heroCode: p.heroCode,
                  displayName: p.displayName,
                  combatProfile: p.combatProfile,
                  skills: p.skills,
                  passives: p.passives,
                },
              ];
            })
          ),
        });
      }

      await streamRemotePathsToZip(
        zip,
        origin,
        filesToStream,
        deps.fetchWithTimeout,
        abortCtrl.signal,
        16
      );

      if (!abortCtrl.signal.aborted) {
        await zip.finalize();
      }
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : 'Erro ao gerar backup ZIP.';
        res.status(400).json({ error: msg });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // 3. Prepare a short-lived token for custom ninja selection standalone offline ZIP
  app.post('/api/backup/custom-prepare', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const rawUrl = typeof body?.url === 'string' ? body.url : 'https://naruto.jotagame.com/';
      const rawIds = Array.isArray(body?.ninjaIds) ? body.ninjaIds : [];
      const cleanIds = Array.from(
        new Set(
          rawIds
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 120)
            .map((x) => x.trim())
        )
      ).slice(0, 1200);

      if (cleanIds.length === 0) {
        res.status(400).json({ error: 'Selecione ao menos 1 ninja para gerar o backup personalizado.' });
        return;
      }

      const { origin: validatedOrigin, catalog } = await resolveValidatedOriginAndData(rawUrl);
      const validSet = new Set(catalog.ninjas.map((n) => n.id));
      const validIds = cleanIds.filter((id) => validSet.has(id));
      if (validIds.length === 0) {
        res.status(400).json({ error: 'Nenhum dos IDs selecionados existe no catálogo.' });
        return;
      }

      pruneExpiredTokens();
      const token = crypto.randomBytes(16).toString('hex');
      const filename =
        validIds.length === 1
          ? sanitizeFilename(`shinobi_offline_${validIds[0]}.zip`)
          : sanitizeFilename(`shinobi_offline_selecao_${validIds.length}_ninjas.zip`);

      customBackupTokens.set(token, {
        createdAt: Date.now(),
        url: `${validatedOrigin}/`,
        ninjaIds: validIds,
        includeParticles: body?.includeParticles !== false,
        includeVideos: body?.includeVideos !== false,
        includeAudio: body?.includeAudio !== false,
        includeNameArt: body?.includeNameArt !== false,
        filename,
        label: `Backup Personalizado (${validIds.length} ${validIds.length === 1 ? 'Ninja' : 'Ninjas'})`,
      });

      res.json({
        token,
        filename,
        ninjaCount: validIds.length,
        downloadUrl: `/api/backup/custom-download?token=${encodeURIComponent(token)}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao preparar backup personalizado.';
      res.status(400).json({ error: msg });
    }
  });

  // 4. Stream custom selection standalone offline ZIP via native browser Download Manager
  app.get('/api/backup/custom-download', async (req, res) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
      if (!token || !/^[a-f0-9]{32}$/.test(token)) {
        res.status(400).json({ error: 'Token de backup inválido ou expirado.' });
        return;
      }
      pruneExpiredTokens();
      const entry = customBackupTokens.get(token);
      if (!entry) {
        res.status(404).json({ error: 'Link de backup expirado. Gere o backup novamente.' });
        return;
      }

      await streamCustomStandaloneBackup(req, res, {
        url: entry.url,
        ninjaIds: entry.ninjaIds,
        includeParticles: entry.includeParticles,
        includeVideos: entry.includeVideos,
        includeAudio: entry.includeAudio,
        includeNameArt: entry.includeNameArt,
        filename: entry.filename,
        label: entry.label,
        moduleId: 'custom',
      });
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : 'Erro ao baixar backup personalizado.';
        res.status(400).json({ error: msg });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}
