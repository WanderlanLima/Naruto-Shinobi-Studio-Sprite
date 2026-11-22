#!/usr/bin/env node
/**
 * Ensures all static data packs for GitHub Pages exist and are complete:
 *  1. public/data/naruto-atlas-pack.zip + public/data/skeletons/skel-0..9.zip
 *     (all catalog ninjas + 6 passive idle auras)
 *  2. public/data/effects-atlas-pack.zip + public/data/effects-skeletons/eff-0..3.zip
 *     (all companion combat particle Spine bundles referenced by {DISPLAY:...}/{DISPLAYTARGET:...})
 *
 * - Fast path: if all packs exist and cover all entries, exits in < 1s with zero network requests.
 * - Recovery path: downloads any missing .atlas/.json directly from origin (no browser CORS limits).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'naruto-catalog.json');
const ATLAS_PACK_PATH = path.join(DATA_DIR, 'naruto-atlas-pack.zip');
const SKEL_DIR = path.join(DATA_DIR, 'skeletons');
const EFFECTS_ATLAS_PACK_PATH = path.join(DATA_DIR, 'effects-atlas-pack.zip');
const EFFECTS_SKEL_DIR = path.join(DATA_DIR, 'effects-skeletons');
const BACKUP_MANIFEST_PACK_PATH = path.join(DATA_DIR, 'backup-manifest.zip');
const NINJA_SKILLS_PACK_PATH = path.join(DATA_DIR, 'ninja-skills-pack.zip');
const NUM_CHUNKS = 10;
const NUM_EFFECT_CHUNKS = 10;
const CONCURRENCY = 20;

const JOTA_DD = [
  0xeb, 0x14, 0x79, 0xb3, 0xa9, 0xd6, 0x0c, 0x6e, 0x2d, 0x7c, 0x0f, 0x45, 0xc3, 0x45, 0x8f, 0x0d,
  0xcc, 0x7f, 0x81, 0x52, 0xfa, 0xb1, 0x4b, 0xc1, 0x7c, 0x49, 0x5b, 0x52, 0x69, 0x3b, 0xfd, 0x96,
];
const JOTA_CD = [
  0x5c, 0x16, 0x0c, 0x5a, 0x22, 0x5e, 0xb5, 0xd2, 0xb4, 0xc6, 0xca, 0xef, 0xbe, 0xbf, 0xde, 0xc2,
  0x95, 0xc0, 0x60, 0xac, 0xf0, 0x7a, 0xd6, 0x64, 0x48, 0x23, 0xec, 0xa8, 0xdb, 0xa0, 0x14, 0xaf,
];

const PASSIVE_AURAS = [
  {
    id: 'noe_ZUOZHUXZbati',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_ZUOZHUXZbati.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_ZUOZHUXZbati.json',
  },
  {
    id: 'noe_Banzhongyanzhizhan_bati',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Banzhongyanzhizhan_bati.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Banzhongyanzhizhan_bati.json',
  },
  {
    id: 'noe_Youzhongguofeng_beidong',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Youzhongguofeng_beidong.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Youzhongguofeng_beidong.json',
  },
  {
    id: 'noe_yuehziyan_daiji',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine/noe_yuehziyan_daiji.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine/noe_yuehziyan_daiji.json',
  },
  {
    id: 'noe_Yuzhibozhishuizhongguofeng_beidong',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Yuzhibozhishuizhongguofeng_beidong.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_Yuzhibozhishuizhongguofeng_beidong.json',
  },
  {
    id: 'noe_xuzuobanbati',
    atlasUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_xuzuobanbati.atlas',
    skeletonUrl: 'https://naruto.jotagame.com/acervo/asset/spine-no-estados/noe_xuzuobanbati.json',
  },
];

function chunkForId(id, numChunks) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % numChunks;
}

function parseAtlasRegions(atlasText) {
  const lines = atlasText.split(/\r?\n/);
  const regions = [];
  let currentPage = '';
  let expectPage = true;
  let currentRegion = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentRegion) {
        regions.push(currentRegion);
        currentRegion = null;
      }
      expectPage = true;
      continue;
    }

    if (expectPage) {
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(trimmed)) {
        currentPage = trimmed;
      }
      expectPage = false;
      continue;
    }

    if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
      if (trimmed.includes(':')) continue;
      if (currentRegion) regions.push(currentRegion);
      currentRegion = { name: trimmed, page: currentPage, x: 0, y: 0, w: 0, h: 0, r: 0 };
      continue;
    }

    if (currentRegion) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'xy') {
        const [x, y] = val.split(',').map((n) => parseInt(n.trim(), 10) || 0);
        currentRegion.x = x;
        currentRegion.y = y;
      } else if (key === 'size') {
        const [w, h] = val.split(',').map((n) => parseInt(n.trim(), 10) || 0);
        currentRegion.w = w;
        currentRegion.h = h;
      } else if (key === 'bounds') {
        const [x, y, w, h] = val.split(',').map((n) => parseInt(n.trim(), 10) || 0);
        currentRegion.x = x;
        currentRegion.y = y;
        currentRegion.w = w;
        currentRegion.h = h;
      } else if (key === 'rotate') {
        if (val === 'true' || val === '90') currentRegion.r = 90;
        else if (val === '180') currentRegion.r = 180;
        else if (val === '270') currentRegion.r = 270;
      }
    }
  }
  if (currentRegion) regions.push(currentRegion);
  return regions;
}

function pickIdleEntry(atlasText, skeletonObj, chunkIndex) {
  const regions = parseAtlasRegions(atlasText);
  if (regions.length === 0) {
    return { frame: '', page: '', x: 0, y: 0, w: 0, h: 0, r: 0, s: chunkIndex };
  }

  const byName = new Map(regions.map((r) => [r.name, r]));
  let chosen = null;

  const anims = skeletonObj?.animations;
  if (anims && typeof anims === 'object') {
    const order = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
    for (const animKey of order) {
      const slots = anims[animKey]?.slots;
      if (!slots) continue;
      const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
      for (const slotAnim of slotOrder) {
        const first = slotAnim?.attachment?.find((a) => typeof a?.name === 'string' && byName.has(a.name));
        if (first) {
          chosen = byName.get(first.name);
          break;
        }
      }
      if (chosen) break;
    }
  }

  if (!chosen) {
    chosen = regions.reduce((best, r) => (r.w * r.h > best.w * best.h ? r : best), regions[0]);
  }

  return {
    frame: chosen.name,
    page: chosen.page,
    x: chosen.x,
    y: chosen.y,
    w: chosen.w,
    h: chosen.h,
    r: chosen.r,
    s: chunkIndex,
  };
}

async function fetchWithRetry(url, retries = 2, allowHtml = false) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ShinobiSpriteStudioBuild/1.0)',
          Referer: 'https://naruto.jotagame.com/',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (resp.ok) {
        const txt = await resp.text();
        if (!allowHtml && txt.trimStart().startsWith('<')) return null;
        return txt;
      }
      if (resp.status === 404) return null;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return null;
}

async function tryLoadZip(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
    return await JSZip.loadAsync(buf);
  } catch {
    return null;
  }
}

async function ensureMainPacks(ninjas) {
  const targets = [
    ...ninjas.map((n) => ({ id: n.id, atlasUrl: n.atlasUrl, skeletonUrl: n.skeletonUrl })),
    ...PASSIVE_AURAS,
  ];

  const existingAtlasZip = (await tryLoadZip(ATLAS_PACK_PATH)) || new JSZip();
  let idleMap = {};
  const existingIdleFile = existingAtlasZip.file('idle-map.json');
  if (existingIdleFile) {
    try {
      idleMap = JSON.parse(await existingIdleFile.async('text'));
    } catch {
      idleMap = {};
    }
  }

  const chunkZips = [];
  let anyChunkMissing = false;
  for (let i = 0; i < NUM_CHUNKS; i++) {
    const z = await tryLoadZip(path.join(SKEL_DIR, `skel-${i}.zip`));
    if (!z) anyChunkMissing = true;
    chunkZips.push(z || new JSZip());
  }

  const missing = [];
  for (const item of targets) {
    const hasAtlas = Boolean(existingAtlasZip.file(`atlas/${item.id}.atlas`));
    const idleEntry = idleMap[item.id];
    const chunkIdx = typeof idleEntry?.s === 'number' ? idleEntry.s : chunkForId(item.id, NUM_CHUNKS);
    const hasSkel = Boolean(chunkZips[chunkIdx]?.file(`${item.id}.json`));
    if (!hasAtlas || !hasSkel || !idleEntry) {
      missing.push({ ...item, hasAtlas, hasSkel, chunkIdx });
    }
  }

  if (missing.length === 0 && !anyChunkMissing && fs.existsSync(ATLAS_PACK_PATH)) {
    console.log(
      `[ensure-static-packs] Main packs OK: ${targets.length} entries (${ninjas.length} ninjas + ${PASSIVE_AURAS.length} auras).`
    );
    return { existingAtlasZip, chunkZips };
  }

  console.log(
    `[ensure-static-packs] Main packs incomplete (${missing.length}/${targets.length} missing). Fetching from origin...`
  );

  let cursor = 0;
  let fetched = 0;
  let failed = 0;
  const dirtyChunks = new Set();

  async function worker() {
    while (cursor < missing.length) {
      const idx = cursor++;
      const item = missing[idx];
      let atlasText = '';
      if (item.hasAtlas) {
        atlasText = await existingAtlasZip.file(`atlas/${item.id}.atlas`).async('text');
      } else {
        const downloaded = await fetchWithRetry(item.atlasUrl);
        if (downloaded && downloaded.trim()) {
          atlasText = downloaded;
          existingAtlasZip.file(`atlas/${item.id}.atlas`, atlasText);
        }
      }

      let skelObj = null;
      if (item.hasSkel) {
        try {
          skelObj = JSON.parse(await chunkZips[item.chunkIdx].file(`${item.id}.json`).async('text'));
        } catch {
          skelObj = null;
        }
      } else if (item.skeletonUrl) {
        const downloaded = await fetchWithRetry(item.skeletonUrl);
        if (downloaded && downloaded.trim().startsWith('{')) {
          try {
            skelObj = JSON.parse(downloaded);
            chunkZips[item.chunkIdx].file(`${item.id}.json`, downloaded);
            dirtyChunks.add(item.chunkIdx);
          } catch {
            skelObj = null;
          }
        }
      }

      if (atlasText) {
        idleMap[item.id] = pickIdleEntry(atlasText, skelObj, item.chunkIdx);
        fetched++;
      } else {
        failed++;
      }

      if ((fetched + failed) % 100 === 0) {
        console.log(`[ensure-static-packs] Main progress: ${fetched + failed}/${missing.length} (ok=${fetched}, fail=${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SKEL_DIR, { recursive: true });

  existingAtlasZip.file('idle-map.json', JSON.stringify(idleMap));
  const atlasBuf = await existingAtlasZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(ATLAS_PACK_PATH, atlasBuf);

  for (let i = 0; i < NUM_CHUNKS; i++) {
    const outPath = path.join(SKEL_DIR, `skel-${i}.zip`);
    if (dirtyChunks.has(i) || !fs.existsSync(outPath)) {
      const skelBuf = await chunkZips[i].generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      fs.writeFileSync(outPath, skelBuf);
    }
  }

  console.log(
    `[ensure-static-packs] Main packs written: naruto-atlas-pack.zip (${(atlasBuf.length / 1024 / 1024).toFixed(2)} MB), recovered=${fetched}, failed=${failed}.`
  );
  return { existingAtlasZip, chunkZips };
}

async function ensureEffectPacks(ninjas, mainAtlasZip, mainSkelZips) {
  const existingMainAtlases = new Set(
    Object.keys(mainAtlasZip.files)
      .filter((k) => k.startsWith('atlas/') && k.endsWith('.atlas'))
      .map((k) => k.slice('atlas/'.length, -'.atlas'.length).toLowerCase())
  );

  const atlasUrlById = new Map(ninjas.map((n) => [n.id.toLowerCase(), n.atlasUrl]));
  const effectRefs = new Map(); // lower -> { id, atlasUrl, skeletonUrl }

  for (const skelZip of mainSkelZips) {
    for (const [name, entry] of Object.entries(skelZip.files)) {
      if (entry.dir || !name.endsWith('.json')) continue;
      const ninjaId = name.slice(0, -'.json'.length);
      const baseAtlasUrl =
        atlasUrlById.get(ninjaId.toLowerCase()) ||
        'https://naruto.jotagame.com/acervo/asset/spine/dummy.atlas';
      let skel;
      try {
        skel = JSON.parse(await entry.async('text'));
      } catch {
        continue;
      }
      const anims = skel?.animations || {};
      for (const anim of Object.values(anims)) {
        if (!anim?.events?.length) continue;
        for (const ev of anim.events) {
          if (!ev?.string) continue;
          for (const m of ev.string.matchAll(/\{([A-Za-z0-9_]+):([^}]+)\}/g)) {
            if (!m[1].startsWith('DISPLAY')) continue;
            const sm = m[2].match(/spine\s*=\s*["']([^"']+)["']/);
            if (!sm?.[1]) continue;
            const spineId = sm[1].trim();
            if (!spineId) continue;
            const low = spineId.toLowerCase();
            if (existingMainAtlases.has(low) || effectRefs.has(low)) continue;
            effectRefs.set(low, {
              id: spineId,
              atlasUrl: new URL(`${spineId}.atlas`, baseAtlasUrl).toString(),
              skeletonUrl: new URL(`${spineId}.json`, baseAtlasUrl).toString(),
            });
          }
        }
      }
    }
  }

  const effectsAtlasZip = (await tryLoadZip(EFFECTS_ATLAS_PACK_PATH)) || new JSZip();
  let chunkMap = {};
  let unavailableSet = new Set();
  const indexFile = effectsAtlasZip.file('effects-index.json');
  if (indexFile) {
    try {
      const parsed = JSON.parse(await indexFile.async('text'));
      if (parsed && typeof parsed === 'object') {
        chunkMap = parsed.chunks && typeof parsed.chunks === 'object' ? parsed.chunks : {};
        if (Array.isArray(parsed.unavailable)) {
          unavailableSet = new Set(parsed.unavailable.map((s) => String(s).toLowerCase()));
        }
      }
    } catch {
      chunkMap = {};
    }
  }

  const effSkelZips = [];
  let anyEffChunkMissing = false;
  for (let i = 0; i < NUM_EFFECT_CHUNKS; i++) {
    const z = await tryLoadZip(path.join(EFFECTS_SKEL_DIR, `eff-${i}.zip`));
    if (!z) anyEffChunkMissing = true;
    effSkelZips.push(z || new JSZip());
  }

  const missing = [];
  for (const [low, item] of effectRefs.entries()) {
    if (unavailableSet.has(low)) continue;
    const hasAtlas = Boolean(effectsAtlasZip.file(`atlas/${item.id}.atlas`));
    const chunkIdx = typeof chunkMap[item.id] === 'number' ? chunkMap[item.id] : chunkForId(item.id, NUM_EFFECT_CHUNKS);
    const hasSkel = Boolean(effSkelZips[chunkIdx]?.file(`${item.id}.json`));
    if (!hasAtlas || !hasSkel) {
      missing.push({ ...item, low, hasAtlas, hasSkel, chunkIdx });
    }
  }

  if (missing.length === 0 && !anyEffChunkMissing && fs.existsSync(EFFECTS_ATLAS_PACK_PATH)) {
    console.log(
      `[ensure-static-packs] Effects packs OK: ${Object.keys(chunkMap).length} particle bundles verified (${unavailableSet.size} 404s skipped).`
    );
    return;
  }

  console.log(
    `[ensure-static-packs] Building effects packs (${missing.length}/${effectRefs.size} pending)...`
  );

  let cursor = 0;
  let fetched = 0;
  let unavailable = 0;
  const dirtyChunks = new Set();

  async function worker() {
    while (cursor < missing.length) {
      const idx = cursor++;
      const item = missing[idx];

      let atlasText = '';
      if (item.hasAtlas) {
        atlasText = await effectsAtlasZip.file(`atlas/${item.id}.atlas`).async('text');
      } else {
        const downloaded = await fetchWithRetry(item.atlasUrl);
        if (downloaded && downloaded.trim()) {
          atlasText = downloaded;
        }
      }

      let skelText = '';
      if (item.hasSkel) {
        skelText = await effSkelZips[item.chunkIdx].file(`${item.id}.json`).async('text');
      } else if (atlasText) {
        const downloaded = await fetchWithRetry(item.skeletonUrl);
        if (downloaded && downloaded.trim().startsWith('{')) {
          try {
            JSON.parse(downloaded);
            skelText = downloaded;
          } catch {
            skelText = '';
          }
        }
      }

      if (atlasText && skelText) {
        if (!item.hasAtlas) effectsAtlasZip.file(`atlas/${item.id}.atlas`, atlasText);
        if (!item.hasSkel) {
          effSkelZips[item.chunkIdx].file(`${item.id}.json`, skelText);
          dirtyChunks.add(item.chunkIdx);
        }
        chunkMap[item.id] = item.chunkIdx;
        fetched++;
      } else {
        unavailableSet.add(item.low);
        unavailable++;
      }

      if ((fetched + unavailable) % 150 === 0) {
        console.log(
          `[ensure-static-packs] Effects progress: ${fetched + unavailable}/${missing.length} (ok=${fetched}, unavailable=${unavailable})`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(EFFECTS_SKEL_DIR, { recursive: true });

  effectsAtlasZip.file(
    'effects-index.json',
    JSON.stringify({
      chunks: chunkMap,
      unavailable: Array.from(unavailableSet).sort(),
    })
  );

  const effAtlasBuf = await effectsAtlasZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(EFFECTS_ATLAS_PACK_PATH, effAtlasBuf);

  for (let i = 0; i < NUM_EFFECT_CHUNKS; i++) {
    const outPath = path.join(EFFECTS_SKEL_DIR, `eff-${i}.zip`);
    if (dirtyChunks.has(i) || !fs.existsSync(outPath)) {
      const skelBuf = await effSkelZips[i].generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      fs.writeFileSync(outPath, skelBuf);
    }
  }

  console.log(
    `[ensure-static-packs] Effects packs written: effects-atlas-pack.zip (${(effAtlasBuf.length / 1024 / 1024).toFixed(2)} MB), packed=${Object.keys(chunkMap).length}, unavailable=${unavailableSet.size}.`
  );
}

function urlToSafeRelPath(rawUrl, expectedOrigin) {
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

async function fetchOriginManifest() {
  const origin = 'https://naruto.jotagame.com';
  const html = await fetchWithRetry(`${origin}/jogar?app=1`, 2, true);
  if (!html) return null;
  const m = html.match(/window\.__VDF_RECURSOS__\s*=\s*\{[^}]*"manifesto"\s*:\s*"([^"]+)"/);
  if (!m?.[1]) return null;
  const manifestoText = await fetchWithRetry(new URL(m[1], origin).toString(), 2);
  if (!manifestoText) return null;
  const man = JSON.parse(manifestoText);
  return { origin, man };
}

async function ensureBackupManifestPack(catalog, cachedManifest) {
  const existing = await tryLoadZip(BACKUP_MANIFEST_PACK_PATH);
  if (existing && existing.file('backup-manifest.json')) {
    try {
      const parsed = JSON.parse(await existing.file('backup-manifest.json').async('text'));
      if (
        parsed &&
        parsed.skillIconsIncluded === true &&
        Array.isArray(parsed.spriteFiles) &&
        parsed.spriteFiles.length > 0
      ) {
        console.log(
          `[ensure-static-packs] Backup manifest OK (sprites=${parsed.spriteFiles.length}, particles=${parsed.particleFiles?.length || 0}, videos=${parsed.videoFiles?.length || 0}, audios=${parsed.audioFiles?.length || 0}, assets=${parsed.assetFiles?.length || 0}).`
        );
        return cachedManifest;
      }
    } catch {
      // rebuild below
    }
  }

  console.log('[ensure-static-packs] Building public/data/backup-manifest.zip from origin...');
  const manifestBundle = cachedManifest || (await fetchOriginManifest());
  if (!manifestBundle) {
    console.warn('[ensure-static-packs] Could not fetch origin manifest for backup-manifest.zip; skipping.');
    return cachedManifest;
  }
  const { origin, man } = manifestBundle;

  const fileSet = new Set();
  const fileSizeByPath = new Map();
  for (const entry of Object.values(man.arquivos || {})) {
    const rel = entry?.url;
    if (!rel) continue;
    fileSet.add(rel);
    fileSizeByPath.set(rel, Number(entry.bytes || 0));
  }

  const baseSet = new Set();
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];
  for (const n of ninjas) {
    const atlasRel = urlToSafeRelPath(n.atlasUrl, origin);
    const skelRel = urlToSafeRelPath(n.skeletonUrl, origin);
    const artRel = n.nameArtUrl ? urlToSafeRelPath(n.nameArtUrl, origin) : null;
    if (atlasRel) baseSet.add(atlasRel);
    if (skelRel) baseSet.add(skelRel);
    if (artRel) baseSet.add(artRel);
  }
  for (const rel of fileSet) {
    if (rel.startsWith('acervo/asset/spine-no-estados/')) {
      baseSet.add(rel);
    }
  }

  const videoFiles = [];
  const audioFiles = [];
  const particleSet = new Set();
  const spriteSet = new Set();
  const assetSet = new Set();

  for (const rel of fileSet) {
    if (
      (rel.startsWith('acervo/video/hero/') || rel.startsWith('acervo/video/recruit/')) &&
      rel.toLowerCase().endsWith('.mp4')
    ) {
      videoFiles.push(rel);
    } else if (rel.startsWith('acervo/som/') && rel.toLowerCase().endsWith('.mp3')) {
      audioFiles.push(rel);
    } else if (rel.startsWith('acervo/asset/spine/')) {
      const fname = rel.slice('acervo/asset/spine/'.length);
      const lower = fname.toLowerCase();
      if (
        lower.startsWith('noe_') ||
        lower.startsWith('efeito_') ||
        /_effect\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower) ||
        /_highteffect\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower) ||
        /_ground\d*\.(atlas|json|webp|png|jpe?g)$/i.test(lower)
      ) {
        if (!baseSet.has(rel)) particleSet.add(rel);
      } else if (/\.(webp|png|jpe?g)$/i.test(lower)) {
        if (!baseSet.has(rel)) spriteSet.add(rel);
      }
    } else if (
      rel.startsWith('acervo/asset/items/skill_') &&
      rel.toLowerCase().endsWith('.png')
    ) {
      if (!baseSet.has(rel)) assetSet.add(rel);
    }
  }

  for (const s of catalog.sheets || []) {
    const rel = urlToSafeRelPath(s.url, origin);
    if (rel && !baseSet.has(rel) && !particleSet.has(rel)) {
      spriteSet.add(rel);
    }
  }
  for (const a of catalog.assets || []) {
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

  const toSizedPairs = (arr) =>
    Array.from(arr)
      .sort()
      .map((p) => [p, fileSizeByPath.get(p) || 0]);

  const manifestPayload = {
    origin,
    generatedAt: new Date().toISOString(),
    skillIconsIncluded: true,
    baseFiles: toSizedPairs(baseSet),
    videoFiles: toSizedPairs(videoFiles),
    audioFiles: toSizedPairs(audioFiles),
    particleFiles: toSizedPairs(particleSet),
    spriteFiles: toSizedPairs(spriteSet),
    assetFiles: toSizedPairs(assetSet),
  };

  const z = new JSZip();
  z.file('backup-manifest.json', JSON.stringify(manifestPayload));
  const buf = await z.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_MANIFEST_PACK_PATH, buf);
  console.log(
    `[ensure-static-packs] Backup manifest written: backup-manifest.zip (${(buf.length / 1024).toFixed(1)} KB, base=${manifestPayload.baseFiles.length}, sprites=${manifestPayload.spriteFiles.length}, particles=${manifestPayload.particleFiles.length}, videos=${manifestPayload.videoFiles.length}, audios=${manifestPayload.audioFiles.length}, assets=${manifestPayload.assetFiles.length}).`
  );
  return manifestBundle;
}

async function ensureNinjaSkillsPack(catalog, cachedManifest) {
  const existing = await tryLoadZip(NINJA_SKILLS_PACK_PATH);
  if (existing && existing.file('ninja-skills.json')) {
    try {
      const parsed = JSON.parse(await existing.file('ninja-skills.json').async('text'));
      const count = parsed?.ninjas ? Object.keys(parsed.ninjas).length : 0;
      if (parsed?.version === 1 && count > 0) {
        console.log(`[ensure-static-packs] Ninja skills pack OK (${count} ninjas with skill icons).`);
        return cachedManifest;
      }
    } catch {
      // rebuild below
    }
  }

  console.log('[ensure-static-packs] Building public/data/ninja-skills-pack.zip from origin tables...');
  const manifestBundle = cachedManifest || (await fetchOriginManifest());
  if (!manifestBundle) {
    console.warn('[ensure-static-packs] Could not fetch origin manifest for ninja-skills-pack.zip; skipping.');
    return cachedManifest;
  }
  const { origin, man } = manifestBundle;
  const v = man.dadosVersao || '0';

  const fileSet = new Set();
  const fileByLower = new Map();
  for (const entry of Object.values(man.arquivos || {})) {
    const rel = entry?.url;
    if (!rel) continue;
    fileSet.add(rel);
    fileByLower.set(rel.toLowerCase(), rel);
  }

  const master = Buffer.from(JOTA_DD.map((val, i) => val ^ JOTA_CD[i]));
  const nomeKey = crypto.createHmac('sha256', master).update('nome').digest();
  const dadosKey = crypto.createHmac('sha256', master).update('dados').digest();

  const fetchDados = async (pathStr) => {
    const slug = crypto
      .createHmac('sha256', nomeKey)
      .update(pathStr)
      .digest()
      .subarray(0, 16)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const resp = await fetch(`${origin}/d/${slug}?v=${v}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShinobiSpriteStudioBuild/1.0)',
        Referer: `${origin}/`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${pathStr}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const decipher = crypto.createDecipheriv('aes-256-gcm', dadosKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    const dec = Buffer.concat([
      decipher.update(buf.subarray(12, buf.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(zlib.gunzipSync(dec).toString('utf8'));
  };

  let herois;
  let pt;
  let roleModels;
  let skills;
  try {
    [herois, pt, roleModels, skills] = await Promise.all([
      fetchDados('dados/jogo/herois.json'),
      fetchDados('dados/jogo/pt.json'),
      fetchDados('dados/tabelas/json/RoleModel.json'),
      fetchDados('dados/jogo/skills.json'),
    ]);
  } catch (err) {
    console.warn('[ensure-static-packs] Failed to decrypt game tables for ninja-skills-pack.zip:', err?.message || err);
    return manifestBundle;
  }

  const resolvePt = (val) => {
    if (!val) return undefined;
    const str = String(val);
    if (str.startsWith('Translate.Id:')) {
      const k = str.slice('Translate.Id:'.length);
      const entry = pt[k];
      if (!entry) return undefined;
      return (Array.isArray(entry) ? String(entry[0] || '') : String(entry)).trim() || undefined;
    }
    const direct = pt[str];
    if (direct) {
      return (Array.isArray(direct) ? String(direct[0] || '') : String(direct)).trim() || undefined;
    }
    return str.trim() || undefined;
  };

  const resolveSkillIconUrl = (iconVal) => {
    if (typeof iconVal !== 'string' || !iconVal.trim()) return {};
    const raw = iconVal.trim().replace(/^\/+/, '');
    const stem = raw.replace(/\.(png|webp|jpe?g)$/i, '');
    const iconName = stem.split('/').pop() || stem;
    const candidates = raw.includes('/')
      ? [
          `${stem}.png`,
          `${stem}.webp`,
          raw,
          `acervo/asset/items/${iconName}.png`,
          `acervo/asset/items/${iconName}.webp`,
        ]
      : [
          `acervo/asset/items/${stem}.png`,
          `acervo/asset/items/${stem}.webp`,
          `acervo/asset/ui/icon/${stem}.png`,
          `acervo/asset/ui/icon/${stem}.webp`,
        ];

    for (const c of candidates) {
      if (fileSet.has(c)) return { iconName, iconUrl: `${origin}/${c}` };
      const low = fileByLower.get(c.toLowerCase());
      if (low) return { iconName, iconUrl: `${origin}/${low}` };
    }
    return { iconName };
  };

  // Pre-index roleModels and herois for fast O(1) lookup
  const rmByTagOrAnim = new Map();
  for (const rm of Object.values(roleModels || {})) {
    if (!rm || typeof rm !== 'object') continue;
    const tag = String(rm.Tag || '').toLowerCase();
    const anim = String(rm.Animation || '').toLowerCase();
    if (tag && !rmByTagOrAnim.has(tag)) rmByTagOrAnim.set(tag, rm);
    if (anim && !rmByTagOrAnim.has(anim)) rmByTagOrAnim.set(anim, rm);
  }
  const heroBySpineOrTag = new Map();
  for (const h of Object.values(herois || {})) {
    const modelo = h?.modelo;
    if (!modelo || typeof modelo !== 'object') continue;
    const sp = String(modelo.spine || '').toLowerCase();
    const tg = String(modelo.tag || '').toLowerCase();
    if (sp && !heroBySpineOrTag.has(sp)) heroBySpineOrTag.set(sp, h);
    if (tg && !heroBySpineOrTag.has(tg)) heroBySpineOrTag.set(tg, h);
  }

  const ninjasOut = {};
  let totalSkillsMapped = 0;
  let totalIconsMapped = 0;
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];

  for (const ninja of ninjas) {
    const idLow = String(ninja.id || '').toLowerCase();
    const code = String(ninja.code || '');
    const code6 = code.length === 8 && code.startsWith('100') ? code.slice(0, 6) : code;

    const rmObj = rmByTagOrAnim.get(idLow) || roleModels?.[code] || roleModels?.[code6];
    const baseHeroObj = rmObj?.model != null ? herois?.[String(rmObj.model)] : undefined;
    const heroObj =
      (rmObj?.Id != null ? herois?.[String(rmObj.Id)] : undefined) ||
      baseHeroObj ||
      heroBySpineOrTag.get(idLow) ||
      herois?.[code] ||
      herois?.[code6];

    if (!heroObj) continue;

    const heroCode =
      heroObj.Id != null ? String(heroObj.Id) : rmObj?.Id != null ? String(rmObj.Id) : code6 || code;
    const displayName =
      (typeof heroObj.name === 'string' && heroObj.name.trim()) ||
      (rmObj?.__link_name ? resolvePt(rmObj.__link_name) : undefined) ||
      ninja.name ||
      undefined;

    const skillsOut = {};
    const addSkill = (animKey, slotLabel, skillId) => {
      if (typeof skillId !== 'string' || !skillId.trim()) return;
      const sk = skills?.[skillId.trim()];
      if (!sk) return;
      const name = resolvePt(sk.name) || skillId.trim();
      const desc = resolvePt(sk.desc);
      const { iconName, iconUrl } = resolveSkillIconUrl(sk.icon);
      skillsOut[animKey] = {
        id: skillId.trim(),
        animKey,
        slotLabel,
        name,
        ...(desc ? { desc } : {}),
        ...(iconName ? { iconName } : {}),
        ...(iconUrl ? { iconUrl } : {}),
      };
      totalSkillsMapped++;
      if (iconUrl) totalIconsMapped++;
    };

    addSkill('attack', 'Ataque Normal', heroObj.normalskill);
    addSkill('skill', 'Habilidade', heroObj.skill);
    addSkill('UniqueSkill', 'Ôgi (Ultimate)', heroObj.superskill);
    addSkill('chase1', 'Perseguição 1', heroObj.chase);
    addSkill('chase2', 'Perseguição 2', heroObj.chase2);
    addSkill('chase3', 'Perseguição 3', heroObj.chase3);

    const passivesOut = [];
    const passiveList = Array.isArray(heroObj.passive) ? heroObj.passive : [];
    for (const pId of passiveList) {
      if (typeof pId !== 'string' || !pId.trim()) continue;
      if (pId === 'hero_hurt' || pId === 'hero_unhurt') continue;
      const sk = skills?.[pId.trim()];
      if (!sk) continue;
      const name = resolvePt(sk.name);
      if (!name) continue;
      const desc = resolvePt(sk.desc);
      const { iconName, iconUrl } = resolveSkillIconUrl(sk.icon);
      passivesOut.push({
        id: pId.trim(),
        name,
        ...(desc ? { desc } : {}),
        ...(iconName ? { iconName } : {}),
        ...(iconUrl ? { iconUrl } : {}),
      });
      totalSkillsMapped++;
      if (iconUrl) totalIconsMapped++;
    }

    if (Object.keys(skillsOut).length > 0 || passivesOut.length > 0) {
      ninjasOut[ninja.id] = {
        ...(heroCode ? { heroCode } : {}),
        ...(displayName ? { displayName } : {}),
        skills: skillsOut,
        passives: passivesOut,
      };
    }
  }

  const payload = {
    version: 1,
    origin,
    generatedAt: new Date().toISOString(),
    ninjas: ninjasOut,
  };

  const z = new JSZip();
  z.file('ninja-skills.json', JSON.stringify(payload));
  const buf = await z.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NINJA_SKILLS_PACK_PATH, buf);
  console.log(
    `[ensure-static-packs] Ninja skills pack written: ninja-skills-pack.zip (${(buf.length / 1024).toFixed(1)} KB, ninjas=${Object.keys(ninjasOut).length}, skills=${totalSkillsMapped}, icons=${totalIconsMapped}).`
  );
  return manifestBundle;
}

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.warn('[ensure-static-packs] public/data/naruto-catalog.json not found; skipping.');
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];
  const { existingAtlasZip, chunkZips } = await ensureMainPacks(ninjas);
  await ensureEffectPacks(ninjas, existingAtlasZip, chunkZips);
  let cachedManifest = await ensureBackupManifestPack(catalog, null);
  await ensureNinjaSkillsPack(catalog, cachedManifest);
}

main().catch((err) => {
  console.error('[ensure-static-packs] Fatal error:', err);
  process.exit(1);
});
