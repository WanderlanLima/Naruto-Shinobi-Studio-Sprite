#!/usr/bin/env node
/**
 * Ensures public/data/naruto-atlas-pack.zip and public/data/skeletons/skel-0..9.zip
 * exist and contain every ninja listed in public/data/naruto-catalog.json plus passive auras.
 *
 * - Fast path: if all static packs already exist and have 0 missing entries, exits immediately (< 0.5s).
 * - Recovery path (e.g. GitHub Actions when binary .zip files were not synced): downloads missing
 *   .atlas and .json files directly from the source host (no browser CORS limits) and builds the packs.
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
const NUM_CHUNKS = 10;
const CONCURRENCY = 16;

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

function chunkForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % NUM_CHUNKS;
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
      if (trimmed.includes(':')) {
        // page-level header property (size, format, filter, repeat)
        continue;
      }
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
      if (resp.ok) return await resp.text();
      if (resp.status === 404) return null;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
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

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.warn('[ensure-static-packs] public/data/naruto-catalog.json not found; skipping.');
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];
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
    const chunkIdx = typeof idleEntry?.s === 'number' ? idleEntry.s : chunkForId(item.id);
    const hasSkel = Boolean(chunkZips[chunkIdx]?.file(`${item.id}.json`));
    if (!hasAtlas || !hasSkel || !idleEntry) {
      missing.push({ ...item, hasAtlas, hasSkel, chunkIdx });
    }
  }

  if (missing.length === 0 && !anyChunkMissing && fs.existsSync(ATLAS_PACK_PATH)) {
    console.log(
      `[ensure-static-packs] OK: all ${targets.length} static entries (${ninjas.length} ninjas + ${PASSIVE_AURAS.length} auras) verified.`
    );
    return;
  }

  console.log(
    `[ensure-static-packs] Missing or incomplete static data (${missing.length}/${targets.length} entries). Fetching from origin...`
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

      let skelText = '';
      let skelObj = null;
      if (item.hasSkel) {
        skelText = await chunkZips[item.chunkIdx].file(`${item.id}.json`).async('text');
        try {
          skelObj = JSON.parse(skelText);
        } catch {
          skelObj = null;
        }
      } else if (item.skeletonUrl) {
        const downloaded = await fetchWithRetry(item.skeletonUrl);
        if (downloaded && downloaded.trim().startsWith('{')) {
          try {
            skelObj = JSON.parse(downloaded);
            skelText = downloaded;
            chunkZips[item.chunkIdx].file(`${item.id}.json`, skelText);
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
        console.log(`[ensure-static-packs] Progress: ${fetched + failed}/${missing.length} (ok=${fetched}, fail=${failed})`);
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
    `[ensure-static-packs] Done! Wrote naruto-atlas-pack.zip (${(atlasBuf.length / 1024 / 1024).toFixed(2)} MB), recovered=${fetched}, failed=${failed}.`
  );
}

main().catch((err) => {
  console.error('[ensure-static-packs] Fatal error:', err);
  process.exit(1);
});
