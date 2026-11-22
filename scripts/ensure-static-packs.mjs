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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const NUM_CHUNKS = 10;
const NUM_EFFECT_CHUNKS = 10;
const CONCURRENCY = 20;

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

async function fetchWithRetry(url, retries = 2) {
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
        if (txt.trimStart().startsWith('<')) return null;
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

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.warn('[ensure-static-packs] public/data/naruto-catalog.json not found; skipping.');
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];
  const { existingAtlasZip, chunkZips } = await ensureMainPacks(ninjas);
  await ensureEffectPacks(ninjas, existingAtlasZip, chunkZips);
}

main().catch((err) => {
  console.error('[ensure-static-packs] Fatal error:', err);
  process.exit(1);
});
