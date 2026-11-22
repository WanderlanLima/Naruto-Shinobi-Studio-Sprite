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

const KNOWN_VDFNO_VIDEOS = {
  vdfno_100304: ['vdfno_MINGRENjlm'],
  vdfno_100306: ['vdfno_ZUOZHU_xznh'],
  vdfno_100307: ['vdfno_qilin'],
  vdfno_100308: ['vdfno_5sskCP'],
  vdfno_100320: ['vdfno_tengkongpao'],
  vdfno_10032091: ['vdfno_tengkongpao'],
  vdfno_10032092: ['vdfno_tengkongpao'],
  vdfno_100349: ['vdfno_21001304'],
  vdfno_100350: ['vdfno_fengyingCP'],
  vdfno_100365: ['vdfno_3kksswlq'],
  vdfno_100384: ['vdfno_wujizhuansheng'],
  vdfno_100407: ['vdfno_Yongzhuanggangshou'],
  vdfno_100409: ['vdfno_YUANFEIsgfj'],
  vdfno_100423: ['vdfno_YOUyd_start'],
  vdfno_100427: ['vdfno_shujiejianglin'],
  vdfno_100432: ['vdfno_erdaidazhao'],
  vdfno_100447: ['vdfno_Hongdouaoyi'],
  vdfno_100467: ['vdfno_XIEdzh'],
  vdfno_100473: ['vdfno_DDLc318f'],
  vdfno_100503: ['vdfno_DAHE_shujiejianglin'],
  vdfno_100511: ['vdfno_DAITUbanwdmx'],
  vdfno_100518: ['vdfno_xiaonan_shizhizhiwu'],
  vdfno_100529: ['vdfno_PEATDdbtx'],
  vdfno_100534: ['vdfno_hanzo'],
  vdfno_100536: ['vdfno_shuiyingCP'],
  vdfno_100541: ['vdfno_TUYING'],
  vdfno_100578: ['vdfno_maohuo'],
  vdfno_100582: ['vdfno_SHICANGhuanggaifeimo'],
  vdfno_100584: ['vdfno_LAOZI'],
  vdfno_100590: ['vdfno_3utkhypm'],
  vdfno_100613: ['vdfno_luosha'],
  vdfno_100633: ['vdfno_TYLX'],
  vdfno_100634: ['vdfno_yuzhiboban_aoyi'],
  vdfno_100638: ['vdfno_zhishui2'],
  vdfno_100646: ['vdfno_5nrtCP'],
};

const SPECIAL_HERO_VIDEO_ALIASES = {
  jifengmingren: ['jfmingren_texie'],
  mingrenjwckl: ['jiuweimingren_donghua'],
  mingrensiwei: ['siweimingren_texie'],
  didala: ['ddl_texie'],
  didalapifu: ['ddl_texie'],
  xcddl: ['ddl_texie'],
  huituchangmen: ['changmen_aoyi'],
  banzang: ['banzang_aoyi'],
  sidaileiying: ['leiying_texie'],
  sidaileiyingpifu: ['leiying_texie'],
  sandaileiying: ['sandaileiyingtexie_left'],
  qiandaipopo: ['qiandai_texie'],
  qilabi: ['qilabi_texie', 'qilabi_texie2', 'qilabi_unskill'],
  qilabiweishou: ['qlbwssp_left'],
  qianshoufeijian1: ['qsfjsp_left'],
  qianshouzhujian1: ['huituzhujiansp_left', 'huituzhujianpifusp_left'],
  renzhankakaxi: ['pbkakaxi_texie', 'pbkakaxi2_texie_left'],
  renzhankakaxipifu: ['pbkakaxi_texie', 'pbkakaxi2_texie_left'],
  anbukakaxi: ['anbukakaxi_texie'],
  xianrenzilaiye: ['xrzly_texie'],
  xznhzuozhu: ['xznhsp'],
  xznhzzpifu: ['xznhsp'],
  yuanfeirizhan: ['yfrz_texie'],
  yuanfeirizhan2: ['zdfyf_texie'],
  huitusandai: ['huituyfrz_left'],
  erwei: ['erweitexie1_left'],
  you: ['you_texie', 'you_unskill'],
  youtangzhuang: ['you_texie', 'you_unskill'],
  youtangzhuangb: ['you_texie', 'you_unskill'],
  baimianju: ['baimianju_texie', 'mianjunantexie'],
  dyyjiaodu: ['jiaodu2_texie', 'jiaodu_texie'],
  huitujiaodu: ['jiaodu_texie', 'jiaodu2_texie'],
  jingmenkai: ['kai_texie'],
  jingmenkaipifu: ['kai_texie'],
  shuimen: ['shuimen_texie'],
  shuimenpifu: ['shuimen_texie'],
  shuimenvippifu: ['shuimen_texie'],
  tiandaochaopifu: ['peien_texie'],
  bhgspifu: ['bhgs_texie'],
  bhgspt: ['bhgs_texie'],
  bhgsptpifu: ['bhgs_texie'],
  gangshouxinchun: ['gangshou_texie'],
  guijiaopifu: ['guijiao_texie'],
  guijiaomaozi: ['guijiao_texie'],
  dayemumaozi: ['dayemu_texie'],
  feiduanpifu: ['feiduan_texie'],
  chuangshengfeiduan: ['feiduan_texie'],
  xiaonanyonghzuang: ['xiaonan_texie'],
  xianrenmingrenpifu: ['xianrenmingren_texie'],
  zhaomeimingpifu: ['zhaomeiming_texie'],
  zhaomeimingyongzhuang: ['zhaomeiming_texie'],
  zilaiyepifu: ['zilaiye_texie'],
  yuzhiboban: ['yuzhibobantexie'],
  yuzhibobanpifu: ['yuzhibobantexie'],
  woailuorjdzpifu: ['woailuorjdz_texie'],
  sasuke: ['Sasuke_texie'],
  shedou: ['xianrendou_texie'],
  shedoupifu: ['xianrendou_texie'],
  renzhanchutianpifu: ['jfchutian_texie'],
  ningcirenzhanpifu: ['jfningci_texie'],
};

function classifySpinePackageKind(id) {
  const lower = id.toLowerCase();
  if (lower.startsWith('vdfno_')) return 'character';
  if (
    lower.includes('_effect') ||
    lower.includes('_highteffect') ||
    lower.includes('_ground') ||
    lower.includes('_tx') ||
    lower.includes('texiao') ||
    lower.includes('huomiao') ||
    lower.startsWith('efeito') ||
    lower.startsWith('fx_') ||
    lower.startsWith('ef_')
  ) {
    return 'effect';
  }
  return 'summon_skin';
}

function stripSkinSuffix(raw) {
  return raw
    .toLowerCase()
    .replace(
      /(?:vippifu|ptpifu|chaopifu|pifu|maozi|xinchun|yongzhuang|yonghzuang|tangzhuangb|tangzhuang|mianju)$/i,
      ''
    );
}

function resolveSoundUrlFromTables(origin, soundKey, sons, fileSet, soundFileByLower) {
  const clean = String(soundKey || '').trim().replace(/\.mp3$/i, '');
  if (!clean) return null;

  const fromSons = sons?.[clean] || sons?.[soundKey];
  if (typeof fromSons === 'string' && fromSons.trim()) {
    const rel = fromSons.trim().replace(/^\/+/, '');
    if (!fileSet.size || fileSet.has(rel)) {
      return `${origin}/${rel}`;
    }
    const lowerMatch = soundFileByLower.get(rel.toLowerCase());
    if (lowerMatch) return `${origin}/${lowerMatch}`;
    return `${origin}/${rel}`;
  }

  const candidates = [];
  if (/^nos_/i.test(clean)) {
    candidates.push(`acervo/som/nos/${clean.slice(4)}.mp3`);
  }
  if (/^die_/i.test(clean)) {
    candidates.push(`acervo/som/Die/${clean}.mp3`);
  }
  candidates.push(
    `acervo/som/${clean}.mp3`,
    `acervo/som/lines/${clean}.mp3`,
    `acervo/som/AFaoyi/${clean}.mp3`
  );
  if (fileSet.size > 0) {
    for (const c of candidates) {
      if (fileSet.has(c)) return `${origin}/${c}`;
      const lowerMatch = soundFileByLower.get(c.toLowerCase());
      if (lowerMatch) return `${origin}/${lowerMatch}`;
    }
  }
  return `${origin}/${candidates[0]}`;
}

function resolveAllHeroVideosFromTables(tables, opts) {
  const { origin, heroVideoByLower, recruitVideoByLower } = tables;
  const videos = [];
  const videoUrlMap = {};
  const seenUrls = new Set();

  const pushVideo = (key, relPath, kind, label) => {
    const fullUrl = `${origin}/${relPath}`;
    const canonicalBase = relPath
      .replace(/^acervo\/video\/(?:hero|recruit)\//i, '')
      .replace(/\.mp4$/i, '');
    videoUrlMap[key] = fullUrl;
    videoUrlMap[canonicalBase] = fullUrl;
    if (seenUrls.has(fullUrl)) return;
    seenUrls.add(fullUrl);
    videos.push({
      key: canonicalBase,
      label:
        label ||
        (kind === 'recruit'
          ? 'Vídeo de Recrutamento / Apresentação'
          : `Vídeo Ultimate (${canonicalBase})`),
      kind,
      url: fullUrl,
    });
  };

  for (const vidSource of opts.requestedVideos || []) {
    const clean = String(vidSource || '').trim().replace(/\.mp4$/i, '');
    if (!clean) continue;
    const low = clean.toLowerCase();
    const rel =
      heroVideoByLower.get(low) ||
      heroVideoByLower.get(`${low}_left`) ||
      heroVideoByLower.get(`${low}_right`) ||
      recruitVideoByLower.get(low);
    if (rel) {
      pushVideo(vidSource, rel, rel.includes('/recruit/') ? 'recruit' : 'ultimate');
    }
  }

  const idLow = String(opts.ninjaId || '').toLowerCase();
  const vdfKeys = KNOWN_VDFNO_VIDEOS[idLow];
  if (vdfKeys) {
    for (const k of vdfKeys) {
      const rel = heroVideoByLower.get(k.toLowerCase());
      if (rel) pushVideo(k, rel, 'ultimate');
    }
  }

  const candidateTags = new Set();
  const addTag = (val) => {
    if (typeof val !== 'string') return;
    const t = val.trim();
    if (!t || t.toLowerCase().startsWith('vdfno_')) return;
    const tl = t.toLowerCase();
    candidateTags.add(tl);
    const stripped = stripSkinSuffix(tl);
    if (stripped && stripped.length >= 3) candidateTags.add(stripped);
  };

  const modelo = opts.heroObj?.modelo;
  const baseModelo = opts.baseHeroObj?.modelo;

  if (!idLow.startsWith('vdfno_')) {
    addTag(opts.ninjaId);
    addTag(opts.rmObj?.Tag);
    addTag(opts.rmObj?.Animation);
    addTag(opts.baseRmObj?.Tag);
    addTag(opts.baseRmObj?.Animation);
    addTag(modelo?.spine);
    addTag(modelo?.tag);
    addTag(baseModelo?.spine);
    addTag(baseModelo?.tag);
  }

  for (const feat of opts.requestedFeatures || []) {
    const fl = String(feat || '').trim().toLowerCase();
    if (!fl || fl === 'tongyongtexie') continue;
    const stem = fl.replace(/(?:pifu)?texie\d*$/i, '').replace(/pifu$/i, '');
    if (stem && stem.length >= 3) {
      candidateTags.add(stem);
      const stripped = stripSkinSuffix(stem);
      if (stripped && stripped.length >= 3) candidateTags.add(stripped);
    }
  }

  for (const tag of candidateTags) {
    const aliases = SPECIAL_HERO_VIDEO_ALIASES[tag];
    if (aliases) {
      for (const alias of aliases) {
        const rel = heroVideoByLower.get(alias.toLowerCase());
        if (rel) pushVideo(alias, rel, 'ultimate');
      }
    }
    const probeBases = [
      `${tag}_texie`,
      `${tag}_aoyi`,
      `${tag}_unskill`,
      `${tag}_donghua`,
      `${tag}texie`,
      `${tag}_texie_left`,
      `${tag}texie_left`,
      `${tag}texie1_left`,
    ];
    for (const p of probeBases) {
      const rel = heroVideoByLower.get(p);
      if (rel) pushVideo(p, rel, 'ultimate');
    }
  }

  const isVdfno = idLow.startsWith('vdfno_');
  const rmMatchesVdfno =
    !isVdfno ||
    String(opts.rmObj?.Tag || '').toLowerCase() === idLow ||
    String(opts.rmObj?.Animation || '').toLowerCase() === idLow;
  const recruitKeys = [
    rmMatchesVdfno ? opts.rmObj?.HeroVideo : undefined,
    !isVdfno ? opts.baseRmObj?.HeroVideo : undefined,
    modelo?.video,
    !isVdfno ? baseModelo?.video : undefined,
  ];
  for (const rk of recruitKeys) {
    if (typeof rk !== 'string' || !rk.trim()) continue;
    const clean = rk.trim().replace(/\.mp4$/i, '');
    const rel =
      recruitVideoByLower.get(clean.toLowerCase()) || heroVideoByLower.get(clean.toLowerCase());
    if (rel) {
      pushVideo(clean, rel, 'recruit', 'Vídeo de Recrutamento / Apresentação');
    }
  }

  return { videos, videoUrlMap };
}

async function fetchOriginManifestAndTables() {
  const manifestBundle = await fetchOriginManifest();
  if (!manifestBundle) return null;
  const { origin, man } = manifestBundle;
  const v = man.dadosVersao || '0';

  const fileSet = new Set();
  const fileByLower = new Map();
  const soundFileByLower = new Map();
  const heroVideoByLower = new Map();
  const recruitVideoByLower = new Map();
  const fileSizeByPath = new Map();

  for (const entry of Object.values(man.arquivos || {})) {
    const rel = entry?.url;
    if (!rel) continue;
    fileSet.add(rel);
    fileSizeByPath.set(rel, Number(entry.bytes || 0));
    const low = rel.toLowerCase();
    fileByLower.set(low, rel);
    if (low.startsWith('acervo/som/') && low.endsWith('.mp3')) {
      soundFileByLower.set(low, rel);
    }
    if (low.startsWith('acervo/video/hero/') && low.endsWith('.mp4')) {
      const base = low.slice('acervo/video/hero/'.length, -4);
      heroVideoByLower.set(base, rel);
    } else if (low.startsWith('acervo/video/recruit/') && low.endsWith('.mp4')) {
      const base = low.slice('acervo/video/recruit/'.length, -4);
      recruitVideoByLower.set(base, rel);
    }
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

  let herois = {};
  let pt = {};
  let roleModels = {};
  let skins = {};
  let skills = {};
  let sons = {};
  try {
    [herois, pt, roleModels, skins, skills, sons] = await Promise.all([
      fetchDados('dados/jogo/herois.json'),
      fetchDados('dados/jogo/pt.json'),
      fetchDados('dados/tabelas/json/RoleModel.json'),
      fetchDados('dados/tabelas/json/SkinConfig.json').catch(() => ({})),
      fetchDados('dados/jogo/skills.json'),
      fetchDados('dados/jogo/sons.json').catch(() => ({})),
    ]);
  } catch (err) {
    console.warn('[ensure-static-packs] Failed to decrypt origin tables:', err?.message || err);
    return null;
  }

  return {
    origin,
    man,
    fileSet,
    fileByLower,
    soundFileByLower,
    heroVideoByLower,
    recruitVideoByLower,
    fileSizeByPath,
    herois,
    pt,
    roleModels,
    skins,
    skills,
    sons,
  };
}

async function syncStaticCatalogFromOrigin(existingCatalog, tablesBundle) {
  const origin = 'https://naruto.jotagame.com';
  const defaultSpineBase = `${origin}/acervo/asset/spine`;

  const [hdText, astcText] = await Promise.all([
    fetchWithRetry(`${origin}/acervo/asset/spine-hd/indice.json`, 2),
    fetchWithRetry(`${origin}/acervo/asset/spine-astc/lista.json`, 2),
  ]);

  if (!hdText || !astcText) {
    console.warn('[ensure-static-packs] Could not fetch live spine-hd/spine-astc indexes; keeping existing catalog.');
    return existingCatalog;
  }

  let hdData = {};
  let astcData = {};
  try {
    hdData = JSON.parse(hdText);
    astcData = JSON.parse(astcText);
  } catch {
    console.warn('[ensure-static-packs] Invalid JSON in live spine indexes; keeping existing catalog.');
    return existingCatalog;
  }

  const tables = tablesBundle || (await fetchOriginManifestAndTables());
  const ninjasRaw = [];
  const sheets = [];

  for (const [key, obj] of Object.entries(hdData || {})) {
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.w === 'number' && typeof obj.h === 'number' && typeof obj.bytes !== 'number' && !key.includes('.')) {
      const codeMatch = key.match(/(\d+)$/);
      ninjasRaw.push({
        id: key,
        code: codeMatch ? codeMatch[1] : key,
        width: Math.round(obj.w),
        height: Math.round(obj.h),
        offsetX: typeof obj.x === 'number' ? Number(obj.x.toFixed(1)) : 0,
        offsetY: typeof obj.y === 'number' ? Number(obj.y.toFixed(1)) : 0,
        atlasUrl: `${defaultSpineBase}/${key}.atlas`,
        skeletonUrl: `${defaultSpineBase}/${key}.json`,
        kind: classifySpinePackageKind(key),
        sourceIndex: 'spine-hd',
      });
    }
  }

  for (const [key, obj] of Object.entries(astcData || {})) {
    if (!obj || typeof obj !== 'object') continue;
    if (/\.(webp|png|jpe?g)$/i.test(key) && typeof obj.w === 'number' && typeof obj.h === 'number') {
      const isNoSheet = key.toLowerCase().startsWith('no_');
      sheets.push({
        name: key,
        url: `${defaultSpineBase}/${key}`,
        width: obj.w,
        height: obj.h,
        bytes: typeof obj.bytes === 'number' ? obj.bytes : undefined,
        sheetKind: isNoSheet ? 'astc_sheet' : 'spine_sheet',
      });
      if (!isNoSheet && !key.toLowerCase().startsWith('vdfno_')) {
        const baseId = key.replace(/\.(webp|png|jpe?g)$/i, '');
        const codeMatch = baseId.match(/(\d+)$/);
        ninjasRaw.push({
          id: baseId,
          code: codeMatch ? codeMatch[1] : baseId,
          width: Math.round(obj.w),
          height: Math.round(obj.h),
          offsetX: 0,
          offsetY: 0,
          atlasUrl: `${defaultSpineBase}/${baseId}.atlas`,
          skeletonUrl: `${defaultSpineBase}/${baseId}.json`,
          kind: classifySpinePackageKind(baseId),
          sourceIndex: 'spine-astc',
        });
      }
    }
  }

  const ninjaMap = new Map();
  for (const n of ninjasRaw) {
    if (
      n.sourceIndex === 'spine-astc' &&
      tables &&
      tables.fileSet.size > 0
    ) {
      const atlasRel = `acervo/asset/spine/${n.id}.atlas`;
      if (!tables.fileSet.has(atlasRel) && !tables.fileByLower.has(atlasRel.toLowerCase())) {
        continue;
      }
    }
    const prev = ninjaMap.get(n.id);
    if (!prev || (prev.sourceIndex !== 'spine-hd' && n.sourceIndex === 'spine-hd')) {
      ninjaMap.set(n.id, n);
    }
  }

  // Preserve any existing code-discovered special Spine entries (like huomiao)
  const existingById = new Map((existingCatalog?.ninjas || []).map((n) => [n.id, n]));
  const existingLowerIds = new Set(Array.from(ninjaMap.keys()).map((k) => k.toLowerCase()));
  for (const prev of existingCatalog?.ninjas || []) {
    if (prev.sourceIndex === 'code' && !existingLowerIds.has(String(prev.id).toLowerCase())) {
      existingLowerIds.add(String(prev.id).toLowerCase());
      ninjaMap.set(prev.id, {
        id: prev.id,
        code: prev.code,
        width: prev.width,
        height: prev.height,
        offsetX: prev.offsetX || 0,
        offsetY: prev.offsetY || 0,
        atlasUrl: prev.atlasUrl,
        skeletonUrl: prev.skeletonUrl,
        kind: prev.kind,
        sourceIndex: 'code',
      });
    }
  }

  // Merge playable classic heroes from herois.json + RoleModel.json (exact parity with server.ts)
  if (tables) {
    const { fileSet, herois, roleModels } = tables;
    const maybeAddPlayableSpine = (spineId, codeVal, w, h) => {
      const cleanId = String(spineId || '').trim();
      if (!cleanId) return;
      const low = cleanId.toLowerCase();
      if (existingLowerIds.has(low)) return;
      if (
        !fileSet.has(`acervo/asset/spine/${cleanId}.atlas`) ||
        !fileSet.has(`acervo/asset/spine/${cleanId}.json`)
      ) {
        return;
      }
      existingLowerIds.add(low);
      ninjaMap.set(cleanId, {
        id: cleanId,
        code: codeVal || cleanId,
        width: Math.max(64, Math.round(w || 180)),
        height: Math.max(64, Math.round(h || 180)),
        offsetX: 0,
        offsetY: 0,
        atlasUrl: `${defaultSpineBase}/${cleanId}.atlas`,
        skeletonUrl: `${defaultSpineBase}/${cleanId}.json`,
        kind: 'character',
        sourceIndex: 'code',
      });
    };

    for (const [heroCode, hObj] of Object.entries(herois || {})) {
      if (!hObj || typeof hObj !== 'object') continue;
      const modelo = hObj.modelo;
      const sp = typeof modelo?.spine === 'string' ? modelo.spine : '';
      if (!sp) continue;
      maybeAddPlayableSpine(sp, heroCode, Number(modelo?.largura) || 180, Number(modelo?.altura) || 180);
    }

    for (const [rmCode, rmObj] of Object.entries(roleModels || {})) {
      if (!rmObj || typeof rmObj !== 'object') continue;
      const sp =
        (typeof rmObj.Animation === 'string' && rmObj.Animation) ||
        (typeof rmObj.Tag === 'string' && rmObj.Tag) ||
        '';
      if (!sp) continue;
      const numId = Number(rmObj.Id ?? rmCode);
      if ((Number.isFinite(numId) && numId >= 100000 && numId < 200000) || Boolean(rmObj.HeroVideo)) {
        maybeAddPlayableSpine(sp, String(rmObj.Id ?? rmCode), Number(rmObj.Width) || 180, Number(rmObj.Height) || 180);
      }
    }
  }

  const uniqueNinjasRaw = Array.from(ninjaMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );

  let finalNinjas = uniqueNinjasRaw;
  if (tables) {
    const { fileSet, herois, pt, roleModels, skins } = tables;
    const resolvePt = (link) => {
      if (!link) return undefined;
      const key = String(link).replace(/^Translate\.Id:/, '');
      const val = pt[key];
      if (!val) return undefined;
      const resolved = Array.isArray(val) ? String(val[0] || '') : String(val);
      return resolved.trim() || undefined;
    };

    const byTag = new Map();
    for (const rm of Object.values(roleModels || {})) {
      if (!rm || typeof rm !== 'object') continue;
      for (const k of [rm.Tag, rm.Animation, rm.SpineAnim]) {
        if (typeof k === 'string' && k && !byTag.has(k.toLowerCase())) {
          byTag.set(k.toLowerCase(), rm);
        }
      }
    }

    const skinByModel = new Map();
    for (const sk of Object.values(skins || {})) {
      if (sk && typeof sk === 'object' && sk.roleModel != null) {
        skinByModel.set(String(sk.roleModel), sk);
      }
    }

    const pickExistingAsset = (candidates) => {
      for (const rel of candidates) {
        if (typeof rel !== 'string' || !rel) continue;
        const clean = rel.replace(/^\/+/, '');
        const ptBase = clean.startsWith('acervo/') ? clean : `acervo/language/pt/${clean}`;
        const ptWebp = ptBase.replace(/\.png$/i, '.webp');
        if (fileSet.has(ptWebp)) return `${origin}/${ptWebp}`;
        if (fileSet.has(ptBase)) return `${origin}/${ptBase}`;
      }
      return undefined;
    };

    finalNinjas = uniqueNinjasRaw.map((n) => {
      const prev = existingById.get(n.id);
      const idLow = n.id.toLowerCase();
      const code6 = n.code.length === 8 && n.code.startsWith('100') ? n.code.slice(0, 6) : n.code;
      const rm = byTag.get(idLow) || roleModels[n.code] || roleModels[code6];
      const modelCode = rm?.model != null ? String(rm.model) : code6;

      let name =
        (rm && resolvePt(rm.__link_name)) ||
        (rm?.model != null
          ? resolvePt(roleModels[String(rm.model)]?.__link_name) || resolvePt(`HeroBase_${rm.model}_name`)
          : undefined) ||
        resolvePt(herois[n.code]?.__link_name) ||
        resolvePt(`HeroBase_${n.code}_name`) ||
        resolvePt(`HeroBase_${code6}_name`);

      const sk = skinByModel.get(String(rm?.Id ?? n.code));
      if (sk) {
        const skName = resolvePt(sk.__link_name);
        if (skName && name && !name.includes(skName)) {
          name = `${name} [${skName}]`;
        } else if (skName && !name) {
          name = skName;
        }
      }

      const nameArtUrl = pickExistingAsset([
        rm?.NamePic,
        `asset/heros/${n.code}/namepic_${n.code}.png`,
        `asset/heros/${modelCode}/namepic_${modelCode}.png`,
        rm?.NewnamePic,
        `asset/heros/Newname/newnamepic_${n.code}.png`,
        `asset/heros/Newname/newnamepic_${modelCode}.png`,
      ]);

      let hasVideo = false;
      if (n.kind !== 'effect') {
        const baseModelKey = rm?.model != null ? String(rm.model) : undefined;
        const baseRmObj = baseModelKey ? roleModels[baseModelKey] : undefined;
        const heroObj =
          herois[n.code] || herois[code6] || (baseModelKey ? herois[baseModelKey] : undefined);
        const baseHeroObj = baseModelKey ? herois[baseModelKey] : undefined;
        const resolvedVids = resolveAllHeroVideosFromTables(tables, {
          ninjaId: n.id,
          code: n.code,
          rmObj: rm,
          baseRmObj,
          heroObj,
          baseHeroObj,
        });
        hasVideo = resolvedVids.videos.length > 0;
      }

      const finalName = name || prev?.name;
      const finalArt = nameArtUrl || prev?.nameArtUrl;
      return {
        ...n,
        ...(finalName ? { name: finalName } : {}),
        ...(finalArt ? { nameArtUrl: finalArt } : {}),
        ...(hasVideo ? { hasVideo: true } : {}),
      };
    });
  }

  const sheetMap = new Map();
  for (const s of sheets) sheetMap.set(s.name, s);
  const uniqueSheets = Array.from(sheetMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );

  const existingAssets = Array.isArray(existingCatalog?.assets) ? existingCatalog.assets : [];
  const nextCatalog = {
    sourceUrl: existingCatalog?.sourceUrl || `${origin}/`,
    resolvedGameUrl: existingCatalog?.resolvedGameUrl || `${origin}/jogar?app=1`,
    gameTitle: existingCatalog?.gameTitle || 'Shinobi: Destino dos Hokages',
    ninjas: finalNinjas,
    sheets: uniqueSheets,
    assets: existingAssets,
    stats: {
      scannedScripts: existingCatalog?.stats?.scannedScripts || 0,
      discoveredAssets: existingAssets.length,
      totalNinjas: finalNinjas.length,
      totalSheets: uniqueSheets.length,
      elapsedMs: existingCatalog?.stats?.elapsedMs || 0,
    },
  };

  const prevCount = existingCatalog?.ninjas?.length || 0;
  const prevIds = (existingCatalog?.ninjas || []).map((n) => n.id).join(',');
  const nextIds = finalNinjas.map((n) => n.id).join(',');
  const prevSheetCount = existingCatalog?.sheets?.length || 0;

  if (prevIds !== nextIds || prevSheetCount !== uniqueSheets.length) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(nextCatalog));
    console.log(
      `[ensure-static-packs] Synced public/data/naruto-catalog.json: ${prevCount} -> ${finalNinjas.length} Spine packs, ${prevSheetCount} -> ${uniqueSheets.length} sheets.`
    );
  } else {
    console.log(
      `[ensure-static-packs] Catalog up-to-date: ${finalNinjas.length} Spine packs, ${uniqueSheets.length} sheets.`
    );
  }

  return { catalog: nextCatalog, tables };
}

async function ensureBackupManifestPack(catalog, cachedTables) {
  const catalogNinjaCount = Array.isArray(catalog.ninjas) ? catalog.ninjas.length : 0;
  const existing = await tryLoadZip(BACKUP_MANIFEST_PACK_PATH);
  if (existing && existing.file('backup-manifest.json')) {
    try {
      const parsed = JSON.parse(await existing.file('backup-manifest.json').async('text'));
      if (
        parsed &&
        parsed.skillIconsInBase === true &&
        parsed.catalogNinjaCount === catalogNinjaCount &&
        Array.isArray(parsed.spriteFiles) &&
        parsed.spriteFiles.length > 0
      ) {
        console.log(
          `[ensure-static-packs] Backup manifest OK (ninjas=${catalogNinjaCount}, sprites=${parsed.spriteFiles.length}, particles=${parsed.particleFiles?.length || 0}, videos=${parsed.videoFiles?.length || 0}, audios=${parsed.audioFiles?.length || 0}, assets=${parsed.assetFiles?.length || 0}).`
        );
        return cachedTables;
      }
    } catch {
      // rebuild below
    }
  }

  console.log('[ensure-static-packs] Building public/data/backup-manifest.zip from origin...');
  const tables = cachedTables || (await fetchOriginManifestAndTables());
  if (!tables) {
    console.warn('[ensure-static-packs] Could not fetch origin manifest for backup-manifest.zip; skipping.');
    return cachedTables;
  }
  const { origin, fileSet, fileSizeByPath } = tables;

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
    const low = rel.toLowerCase();
    if (
      rel.startsWith('acervo/asset/spine-no-estados/') ||
      ((rel.startsWith('acervo/asset/items/skill_') || rel.startsWith('acervo/asset/ui/icon/')) &&
        (low.endsWith('.png') || low.endsWith('.webp')))
    ) {
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
    catalogNinjaCount,
    skillIconsIncluded: true,
    skillIconsInBase: true,
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
  return tables;
}

const CHASE_STATE_LABELS = {
  fall: 'Queda / Derrubado',
  popup: 'Flutuação Baixa',
  launcher: 'Flutuação Alta',
  back: 'Empurrão / Repelido',
};

const NATURE_MAP = {
  1: { code: 'wind', label: 'Vento' },
  2: { code: 'fire', label: 'Fogo' },
  3: { code: 'earth', label: 'Terra' },
  4: { code: 'water', label: 'Água' },
  5: { code: 'thunder', label: 'Relâmpago' },
};

const COMBAT_ROLE_LABELS = {
  tank: 'Tanque',
  gank: 'Controle / Estratégia',
  dps: 'Dano (DPS)',
};

const TARGET_MAP = {
  ENEMY: { type: 'single_enemy', label: 'Único Inimigo' },
  ENEMY_ROW: { type: 'enemy_row', label: 'Fileira de Inimigos' },
  ENEMY_COL: { type: 'enemy_col', label: 'Coluna de Inimigos' },
  ENEMY_ALL: { type: 'all_enemies', label: 'Todos os Inimigos' },
  ENEMY3: { type: 'multi_enemy_3', label: 'Até 3 Inimigos' },
  ENEMY_RANDOM_2: { type: 'random_enemies', label: '2 Inimigos Aleatórios' },
  ENEMY_RANDOM_3: { type: 'random_enemies', label: '3 Inimigos Aleatórios' },
  ENEMY_RANDOM_4: { type: 'random_enemies', label: '4 Inimigos Aleatórios' },
  ENEMY_RANDOM_5: { type: 'random_enemies', label: '5 Inimigos Aleatórios' },
  FRIEND_ALL: { type: 'all_allies', label: 'Todos os Aliados' },
};

const DAMAGE_CATEGORY_TERMS = new Set([
  'taijutsu',
  'ninjutsu',
  'taijutsu/ninjutsu',
  'ninjutsu/taijutsu',
  'genjutsu',
]);

const ELEMENT_BRACKET_TERMS = new Set([
  'fogo',
  'água',
  'agua',
  'vento',
  'trovão',
  'trovao',
  'relâmpago',
  'relampago',
  'raio',
  'terra',
  'madeira',
]);

function stripHtmlTags(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChaseFlag(flag) {
  if (typeof flag !== 'string') return null;
  const f = flag.trim().toLowerCase();
  return f === 'fall' || f === 'popup' || f === 'launcher' || f === 'back' ? f : null;
}

function detectChaseStateFromTerm(termRaw) {
  const t = String(termRaw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (t === 'derrubar' || t === 'derrubado' || t === 'queda' || t === 'caido' || t.includes('derrub')) {
    return 'fall';
  }
  if (
    t === 'flutuacao baixa' ||
    t === 'flutuacao pequena' ||
    t === 'flutuacao menor' ||
    t.includes('flutuacao baixa') ||
    t.includes('flutuacao pequena') ||
    t.includes('flutuacao menor')
  ) {
    return 'popup';
  }
  if (
    t === 'flutuacao alta' ||
    t === 'grande flutuacao' ||
    t.includes('flutuacao alta') ||
    t.includes('grande flutuacao')
  ) {
    return 'launcher';
  }
  if (
    t === 'empurrao' ||
    t === 'empurrado' ||
    t === 'repelir' ||
    t === 'repelido' ||
    t === 'repelimento' ||
    t === 'repulsao' ||
    t.includes('empurr') ||
    t.includes('repel')
  ) {
    return 'back';
  }
  return null;
}

function extractCausedChaseStates(descPlain, knownTriggers = []) {
  if (!descPlain) return [];
  const caused = new Set();
  const resultClauseRegex =
    /(?:para\s+causar|causa(?:ndo)?|inflig(?:e|ir|indo)|gera(?:ndo)?|provoca(?:ndo)?|arremessa(?:ndo)?|lança(?:ndo)?)\s*(?:o\s+|um\s+|uma\s+|efeito\s+de\s+|estado\s+de\s+)?\[([^\]]{2,32})\]/gi;
  let match;
  while ((match = resultClauseRegex.exec(descPlain)) !== null) {
    const st = detectChaseStateFromTerm(match[1]);
    if (st) caused.add(st);
  }
  if (knownTriggers.length === 0) {
    const bracketRegex = /\[([^\]]{2,32})\]/g;
    while ((match = bracketRegex.exec(descPlain)) !== null) {
      const st = detectChaseStateFromTerm(match[1]);
      if (st) caused.add(st);
    }
  } else if (caused.size === 0) {
    const foundInOrder = [];
    const bracketRegex = /\[([^\]]{2,32})\]/g;
    while ((match = bracketRegex.exec(descPlain)) !== null) {
      const st = detectChaseStateFromTerm(match[1]);
      if (st) foundInOrder.push(st);
    }
    if (foundInOrder.length >= 2) {
      for (const st of foundInOrder.slice(1)) caused.add(st);
    } else if (foundInOrder.length === 1 && !knownTriggers.includes(foundInOrder[0])) {
      caused.add(foundInOrder[0]);
    }
  }
  return Array.from(caused);
}

function parseRawSkillMechanicsStatic(rawSkill, descResolved, resolvePt) {
  const descPlain = stripHtmlTags(descResolved);
  const descShort = stripHtmlTags(resolvePt(rawSkill.desc_short));
  const descInBattle = stripHtmlTags(resolvePt(rawSkill.descInBattle));
  const rawFlags = Array.isArray(rawSkill.flags)
    ? rawSkill.flags.map((f) => String(f || '').trim()).filter(Boolean)
    : [];

  let targetType;
  let targetLabel;
  const elementsSet = new Set();
  for (const f of rawFlags) {
    if (!targetType && TARGET_MAP[f]) {
      targetType = TARGET_MAP[f].type;
      targetLabel = TARGET_MAP[f].label;
    }
    const low = f.toLowerCase();
    if (low === 'fire' || low === 'water' || low === 'wind' || low === 'thunder' || low === 'earth') {
      elementsSet.add(low);
    }
  }

  const chaseTriggers = [];
  if (Array.isArray(rawSkill.chaseFlags)) {
    for (const cf of rawSkill.chaseFlags) {
      const norm = normalizeChaseFlag(cf);
      if (norm && !chaseTriggers.includes(norm)) chaseTriggers.push(norm);
    }
  }

  const causesChaseStates = extractCausedChaseStates(descPlain, chaseTriggers);
  const damageCategories = [];
  const appliedEffects = [];
  const seenEffects = new Set();

  const bracketRegex = /\[([^\]]{2,40})\]/g;
  let bMatch;
  while ((bMatch = bracketRegex.exec(descPlain)) !== null) {
    const term = bMatch[1].trim();
    const low = term.toLowerCase();
    if (DAMAGE_CATEGORY_TERMS.has(low)) {
      if (!damageCategories.includes(term)) damageCategories.push(term);
      continue;
    }
    if (ELEMENT_BRACKET_TERMS.has(low)) {
      if (low === 'fogo') elementsSet.add('fire');
      else if (low === 'água' || low === 'agua') elementsSet.add('water');
      else if (low === 'vento') elementsSet.add('wind');
      else if (low === 'terra') elementsSet.add('earth');
      else if (low === 'trovão' || low === 'trovao' || low === 'relâmpago' || low === 'relampago' || low === 'raio') {
        elementsSet.add('thunder');
      }
      continue;
    }
    if (detectChaseStateFromTerm(term)) continue;
    if (!seenEffects.has(low)) {
      seenEffects.add(low);
      appliedEffects.push(term);
    }
  }

  const effectIds = Array.isArray(rawSkill.effects)
    ? rawSkill.effects.map((e) => String(e || '').trim()).filter(Boolean)
    : [];

  let effectDescs;
  if (rawSkill.EffectDesc && typeof rawSkill.EffectDesc === 'object') {
    const out = {};
    for (const [lv, val] of Object.entries(rawSkill.EffectDesc)) {
      const clean = stripHtmlTags(resolvePt(val));
      if (clean) out[lv] = clean;
    }
    if (Object.keys(out).length > 0) effectDescs = out;
  }

  const skillType =
    typeof rawSkill.type === 'number' && Number.isFinite(rawSkill.type) ? rawSkill.type : undefined;
  const actionFlags =
    typeof rawSkill.ActionFlags === 'string' && rawSkill.ActionFlags.trim()
      ? rawSkill.ActionFlags.trim()
      : undefined;

  return {
    ...(descResolved ? { desc: descResolved } : {}),
    ...(descPlain ? { descPlain } : {}),
    ...(descShort ? { descShort } : {}),
    ...(descInBattle ? { descInBattle } : {}),
    ...(skillType != null ? { skillType } : {}),
    ...(damageCategories.length > 0 ? { damageCategories } : {}),
    ...(elementsSet.size > 0 ? { elements: Array.from(elementsSet) } : {}),
    ...(rawFlags.length > 0 ? { targetFlags: rawFlags } : {}),
    ...(targetType ? { targetType, targetLabel } : {}),
    ...(actionFlags ? { actionFlags } : {}),
    ...(chaseTriggers.length > 0
      ? {
          chaseTriggers,
          chaseTriggerLabels: chaseTriggers.map((c) => CHASE_STATE_LABELS[c]),
        }
      : {}),
    ...(causesChaseStates.length > 0
      ? {
          causesChaseStates,
          causesChaseStateLabels: causesChaseStates.map((c) => CHASE_STATE_LABELS[c]),
        }
      : {}),
    ...(appliedEffects.length > 0 ? { appliedEffects } : {}),
    ...(effectIds.length > 0 ? { effectIds } : {}),
    ...(effectDescs ? { effectDescs } : {}),
  };
}

function numOrUndefined(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function buildHeroCombatProfileStatic(heroObj, heroCode, displayName, skillsOut, passivesOut) {
  const initiators = [];
  const chasers = [];
  for (const [slot, sk] of Object.entries(skillsOut)) {
    const hasTrigger = Array.isArray(sk.chaseTriggers) && sk.chaseTriggers.length > 0;
    const hasCaused = Array.isArray(sk.causesChaseStates) && sk.causesChaseStates.length > 0;
    if (hasTrigger) {
      chasers.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        requiresStates: sk.chaseTriggers,
        requiresStateLabels: sk.chaseTriggerLabels,
        ...(hasCaused
          ? { causesStates: sk.causesChaseStates, causesStateLabels: sk.causesChaseStateLabels }
          : {}),
        ...(sk.appliedEffects?.length ? { appliedEffects: sk.appliedEffects } : {}),
      });
    } else if (hasCaused) {
      initiators.push({
        slot,
        skillId: sk.id,
        skillName: sk.name,
        causesStates: sk.causesChaseStates,
        causesStateLabels: sk.causesChaseStateLabels,
        ...(sk.appliedEffects?.length ? { appliedEffects: sk.appliedEffects } : {}),
      });
    }
  }
  for (const p of passivesOut) {
    const hasTrigger = Array.isArray(p.chaseTriggers) && p.chaseTriggers.length > 0;
    const hasCaused = Array.isArray(p.causesChaseStates) && p.causesChaseStates.length > 0;
    if (hasTrigger) {
      chasers.push({
        slot: 'passive',
        skillId: p.id,
        skillName: p.name,
        requiresStates: p.chaseTriggers,
        requiresStateLabels: p.chaseTriggerLabels,
        ...(hasCaused
          ? { causesStates: p.causesChaseStates, causesStateLabels: p.causesChaseStateLabels }
          : {}),
        ...(p.appliedEffects?.length ? { appliedEffects: p.appliedEffects } : {}),
      });
    }
  }

  if (!heroObj && initiators.length === 0 && chasers.length === 0) return undefined;

  const natureId = numOrUndefined(heroObj?.nature);
  const natureInfo = natureId != null ? NATURE_MAP[natureId] : undefined;
  const combatRole =
    typeof heroObj?.type === 'string' && heroObj.type.trim() ? heroObj.type.trim() : undefined;
  const rolePosition = stripHtmlTags(typeof heroObj?.position === 'string' ? heroObj.position : '');
  const shortDesc = stripHtmlTags(typeof heroObj?.shortdesc === 'string' ? heroObj.shortdesc : '');
  const tags = Array.isArray(heroObj?.flags)
    ? heroObj.flags.map((f) => String(f || '').trim()).filter(Boolean)
    : undefined;

  const baseStats = heroObj
    ? {
        hp: numOrUndefined(heroObj.lifenum),
        attack: numOrUndefined(heroObj.attacknum),
        defense: numOrUndefined(heroObj.defensenum),
        hpGrowth: numOrUndefined(heroObj.hp),
        attackGrowth: numOrUndefined(heroObj.attack),
        defenseGrowth: numOrUndefined(heroObj.defense),
        crit: numOrUndefined(heroObj.crit),
        uncrit: numOrUndefined(heroObj.uncrit),
        critDeepen: numOrUndefined(heroObj.critdeepen),
        block: numOrUndefined(heroObj.block),
        unblock: numOrUndefined(heroObj.unblock),
        blockDeepen: numOrUndefined(heroObj.blockdeepen),
        hurtBonus: numOrUndefined(heroObj.hurt),
        hurtReduction: numOrUndefined(heroObj.unhurt),
        skillRate: numOrUndefined(heroObj.skillrate),
        lifesteal: numOrUndefined(heroObj.suck),
        control: numOrUndefined(heroObj.ctrl),
        uncontrol: numOrUndefined(heroObj.unctrl),
        cure: numOrUndefined(heroObj.cure),
        ultimateDamage: numOrUndefined(heroObj.bishadamage),
        ultimateDefense: numOrUndefined(heroObj.bishadefense),
      }
    : undefined;

  const chakraAnger =
    heroObj && (heroObj.anger != null || heroObj.angerbase != null)
      ? {
          base: numOrUndefined(heroObj.angerbase),
          ...(heroObj.anger && typeof heroObj.anger === 'object' ? { rules: heroObj.anger } : {}),
        }
      : undefined;

  return {
    heroCode: heroCode || String(heroObj?.Id || ''),
    name: displayName || String(heroObj?.name || ''),
    ...(shortDesc ? { shortDesc } : {}),
    ...(rolePosition ? { rolePosition } : {}),
    ...(combatRole
      ? { combatRole, combatRoleLabel: COMBAT_ROLE_LABELS[combatRole] || combatRole }
      : {}),
    ...(natureId != null
      ? {
          natureId,
          ...(natureInfo ? { nature: natureInfo.code, natureLabel: natureInfo.label } : {}),
        }
      : {}),
    ...(numOrUndefined(heroObj?.quality) != null ? { quality: numOrUndefined(heroObj?.quality) } : {}),
    ...(numOrUndefined(heroObj?.star) != null ? { star: numOrUndefined(heroObj?.star) } : {}),
    ...(numOrUndefined(heroObj?.maxStar) != null ? { maxStar: numOrUndefined(heroObj?.maxStar) } : {}),
    ...(typeof heroObj?.teamid === 'string' && heroObj.teamid.trim()
      ? { teamId: heroObj.teamid.trim() }
      : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(baseStats ? { baseStats } : {}),
    ...(chakraAnger ? { chakraAnger } : {}),
    chaseComboSummary: {
      initiators,
      chasers,
    },
  };
}

async function ensureNinjaSkillsPack(catalog, mainSkelZips, cachedTables) {
  const catalogNinjaCount = Array.isArray(catalog.ninjas) ? catalog.ninjas.length : 0;
  const existing = await tryLoadZip(NINJA_SKILLS_PACK_PATH);
  if (existing && existing.file('ninja-skills.json')) {
    try {
      const parsed = JSON.parse(await existing.file('ninja-skills.json').async('text'));
      const count = parsed?.ninjas ? Object.keys(parsed.ninjas).length : 0;
      if (
        parsed?.version === 3 &&
        parsed?.catalogNinjaCount === catalogNinjaCount &&
        count > 0 &&
        parsed?.sons &&
        typeof parsed.sons === 'object'
      ) {
        console.log(
          `[ensure-static-packs] Ninja media/skills/combat pack v3 OK (${count} ninjas, ${Object.keys(parsed.sons).length} sound mappings).`
        );
        return cachedTables;
      }
    } catch {
      // rebuild below
    }
  }

  console.log('[ensure-static-packs] Building public/data/ninja-skills-pack.zip (v3: skills, combat mechanics, chase triggers, stats, icons, voices, videos, sons)...');
  const tables = cachedTables || (await fetchOriginManifestAndTables());
  if (!tables) {
    console.warn('[ensure-static-packs] Could not fetch origin tables for ninja-skills-pack.zip; skipping.');
    return cachedTables;
  }
  const { origin, fileSet, fileByLower, soundFileByLower, herois, pt, roleModels, skills, sons } = tables;

  // Scan packed skeletons for {PLAYVEDIO:...} and {SHOWFEATURE:...} refs per ninja
  const skelVideoRefsByLower = new Map();
  const skelFeatureRefsByLower = new Map();
  for (const skelZip of mainSkelZips || []) {
    for (const [name, entry] of Object.entries(skelZip.files)) {
      if (entry.dir || !name.endsWith('.json')) continue;
      const ninjaIdLow = name.slice(0, -'.json'.length).toLowerCase();
      let skel;
      try {
        skel = JSON.parse(await entry.async('text'));
      } catch {
        continue;
      }
      const vids = new Set();
      const feats = new Set();
      for (const anim of Object.values(skel?.animations || {})) {
        for (const ev of anim?.events || []) {
          if (!ev?.string) continue;
          for (const m of ev.string.matchAll(/\{([A-Za-z0-9_]+):([^}]+)\}/g)) {
            const cmd = m[1].toUpperCase();
            const body = m[2];
            if (cmd === 'PLAYVEDIO' || cmd === 'PLAYVIDEO') {
              const sm = body.match(/source\s*=\s*["']([^"']+)["']/i);
              if (sm?.[1]) vids.add(sm[1].trim());
            } else if (cmd === 'SHOWFEATURE') {
              const fm = body.match(/file\s*=\s*["']([^"']+)["']/i);
              if (fm?.[1]) {
                for (const part of fm[1].split(',')) {
                  const p = part.trim();
                  if (p) feats.add(p);
                }
              }
            }
          }
        }
      }
      if (vids.size > 0) skelVideoRefsByLower.set(ninjaIdLow, Array.from(vids));
      if (feats.size > 0) skelFeatureRefsByLower.set(ninjaIdLow, Array.from(feats));
    }
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
  let totalVoicesMapped = 0;
  let totalVideosMapped = 0;
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];

  for (const ninja of ninjas) {
    const idLow = String(ninja.id || '').toLowerCase();
    const code = String(ninja.code || '');
    const code6 = code.length === 8 && code.startsWith('100') ? code.slice(0, 6) : code;

    const rmObj = rmByTagOrAnim.get(idLow) || roleModels?.[code] || roleModels?.[code6];
    const baseRmObj = rmObj?.model != null ? roleModels?.[String(rmObj.model)] : undefined;
    const baseHeroObj = rmObj?.model != null ? herois?.[String(rmObj.model)] : undefined;
    const heroObj =
      (rmObj?.Id != null ? herois?.[String(rmObj.Id)] : undefined) ||
      baseHeroObj ||
      heroBySpineOrTag.get(idLow) ||
      herois?.[code] ||
      herois?.[code6];

    const heroCode =
      heroObj?.Id != null ? String(heroObj.Id) : rmObj?.Id != null ? String(rmObj.Id) : code6 || code;
    const displayName =
      (typeof heroObj?.name === 'string' && heroObj.name.trim()) ||
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
      const mechanics = parseRawSkillMechanicsStatic(sk, desc, resolvePt);
      skillsOut[animKey] = {
        id: skillId.trim(),
        animKey,
        slotLabel,
        name,
        ...mechanics,
        ...(iconName ? { iconName } : {}),
        ...(iconUrl ? { iconUrl } : {}),
      };
      totalSkillsMapped++;
      if (iconUrl) totalIconsMapped++;
    };

    const passivesOut = [];
    if (heroObj) {
      addSkill('attack', 'Ataque Normal', heroObj.normalskill);
      addSkill('skill', 'Habilidade', heroObj.skill);
      addSkill('UniqueSkill', 'Ôgi (Ultimate)', heroObj.superskill);
      addSkill('chase1', 'Perseguição 1', heroObj.chase);
      addSkill('chase2', 'Perseguição 2', heroObj.chase2);
      addSkill('chase3', 'Perseguição 3', heroObj.chase3);

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
        const mechanics = parseRawSkillMechanicsStatic(sk, desc, resolvePt);
        passivesOut.push({
          id: pId.trim(),
          name,
          ...(mechanics.desc ? { desc: mechanics.desc } : {}),
          ...(mechanics.descPlain ? { descPlain: mechanics.descPlain } : {}),
          ...(iconName ? { iconName } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          ...(mechanics.skillType != null ? { skillType: mechanics.skillType } : {}),
          ...(mechanics.targetFlags ? { targetFlags: mechanics.targetFlags } : {}),
          ...(mechanics.chaseTriggers ? { chaseTriggers: mechanics.chaseTriggers } : {}),
          ...(mechanics.chaseTriggerLabels ? { chaseTriggerLabels: mechanics.chaseTriggerLabels } : {}),
          ...(mechanics.causesChaseStates ? { causesChaseStates: mechanics.causesChaseStates } : {}),
          ...(mechanics.causesChaseStateLabels
            ? { causesChaseStateLabels: mechanics.causesChaseStateLabels }
            : {}),
          ...(mechanics.appliedEffects ? { appliedEffects: mechanics.appliedEffects } : {}),
          ...(mechanics.effectIds ? { effectIds: mechanics.effectIds } : {}),
          ...(mechanics.effectDescs ? { effectDescs: mechanics.effectDescs } : {}),
        });
        totalSkillsMapped++;
        if (iconUrl) totalIconsMapped++;
      }
    }

    // Voices (exact parity with server.ts)
    const voicesOut = [];
    const seenVoiceKeys = new Set();
    const pushVoice = (category, label, keyVal) => {
      const keys = Array.isArray(keyVal)
        ? keyVal
        : typeof keyVal === 'string' && keyVal.trim()
        ? [keyVal.trim()]
        : [];
      for (const k of keys) {
        if (typeof k !== 'string' || !k.trim()) continue;
        const cleanKey = k.trim();
        const url = resolveSoundUrlFromTables(origin, cleanKey, sons, fileSet, soundFileByLower);
        if (!url) continue;
        const dedupeKey = `${category}::${cleanKey}`;
        if (seenVoiceKeys.has(dedupeKey)) continue;
        seenVoiceKeys.add(dedupeKey);
        voicesOut.push({ key: cleanKey, category, label, url });
        totalVoicesMapped++;
      }
    };

    const modelo = heroObj?.modelo;
    const vozesRoot = modelo?.vozes;
    const vdfVozes =
      vozesRoot?.[heroCode] ||
      vozesRoot?.[code6] ||
      (vozesRoot && typeof vozesRoot === 'object' ? Object.values(vozesRoot)[0] : undefined) ||
      rmObj?.VdfVozes;

    if (vdfVozes && typeof vdfVozes === 'object') {
      pushVoice('batalha', 'Voz de Batalha', vdfVozes.batalha);
      pushVoice('transformacao', 'Transformação / Especial', vdfVozes.transformacao);
      pushVoice('despertar', 'Despertar', vdfVozes.despertar);
      pushVoice('subir_estrela', 'Subir Estrela', vdfVozes.subir_estrela);
    }

    const modeloAudio = modelo?.audio;
    if (modeloAudio && typeof modeloAudio === 'object') {
      pushVoice('luta', 'Entrada em Luta', modeloAudio.luta);
      pushVoice('skill', 'Voz de Habilidade', modeloAudio.skill);
      pushVoice('unica', 'Voz de Ôgi', modeloAudio.unica);
      pushVoice('dor', 'Recebendo Dano', modeloAudio.dor);
      pushVoice('morte', 'Voz de Derrota', modeloAudio.morte);
    }
    for (const rmCandidate of [rmObj, baseRmObj]) {
      if (!rmCandidate) continue;
      pushVoice('luta', 'Entrada em Luta', rmCandidate.FightingAudio);
      pushVoice('skill', 'Voz de Habilidade', rmCandidate.SkillAudio);
      pushVoice('unica', 'Voz de Ôgi', rmCandidate.Uniquevoice);
      pushVoice('dor', 'Recebendo Dano', rmCandidate.UnderAttackAudio);
      pushVoice('morte', 'Voz de Derrota', rmCandidate.DeadAudio);
    }

    // Videos (exact parity with server.ts, including skeleton {PLAYVEDIO}/{SHOWFEATURE})
    const resolvedVids = resolveAllHeroVideosFromTables(tables, {
      ninjaId: ninja.id,
      code,
      rmObj,
      baseRmObj,
      heroObj,
      baseHeroObj,
      requestedVideos: skelVideoRefsByLower.get(idLow),
      requestedFeatures: skelFeatureRefsByLower.get(idLow),
    });
    totalVideosMapped += resolvedVids.videos.length;

    const combatProfile = buildHeroCombatProfileStatic(
      heroObj,
      heroCode || '',
      displayName || ninja.id,
      skillsOut,
      passivesOut
    );

    if (
      combatProfile ||
      Object.keys(skillsOut).length > 0 ||
      passivesOut.length > 0 ||
      voicesOut.length > 0 ||
      resolvedVids.videos.length > 0
    ) {
      ninjasOut[ninja.id] = {
        ...(heroCode ? { heroCode } : {}),
        ...(displayName ? { displayName } : {}),
        ...(combatProfile ? { combatProfile } : {}),
        skills: skillsOut,
        passives: passivesOut,
        ...(voicesOut.length > 0 ? { voices: voicesOut } : {}),
        ...(resolvedVids.videos.length > 0 ? { videos: resolvedVids.videos } : {}),
        ...(Object.keys(resolvedVids.videoUrlMap).length > 0
          ? { videoUrlMap: resolvedVids.videoUrlMap }
          : {}),
      };
    }
  }

  // Build compact global sound map (sons.json + manifest sound filenames for case-accurate resolution)
  const compactSons = {};
  for (const [k, v] of Object.entries(sons || {})) {
    if (typeof v === 'string' && v.trim()) {
      compactSons[k] = v.trim().replace(/^\/+/, '');
    }
  }
  for (const rel of soundFileByLower.values()) {
    const file = rel.split('/').pop() || '';
    const stem = file.replace(/\.mp3$/i, '');
    if (stem && !compactSons[stem]) {
      compactSons[stem] = rel;
    }
  }

  const payload = {
    version: 3,
    catalogNinjaCount,
    origin,
    generatedAt: new Date().toISOString(),
    sons: compactSons,
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
    `[ensure-static-packs] Ninja media/skills/combat pack v3 written: ninja-skills-pack.zip (${(buf.length / 1024).toFixed(1)} KB, ninjas=${Object.keys(ninjasOut).length}, skills=${totalSkillsMapped}, icons=${totalIconsMapped}, voices=${totalVoicesMapped}, videos=${totalVideosMapped}, sons=${Object.keys(compactSons).length}).`
  );
  return tables;
}

async function main() {
  let existingCatalog = null;
  if (fs.existsSync(CATALOG_PATH)) {
    try {
      existingCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    } catch {
      existingCatalog = null;
    }
  }

  const synced = await syncStaticCatalogFromOrigin(existingCatalog, null);
  const catalog = synced?.catalog || existingCatalog;
  if (!catalog) {
    console.warn('[ensure-static-packs] public/data/naruto-catalog.json not found and origin sync unavailable; skipping.');
    return;
  }

  let cachedTables = synced?.tables || null;
  const ninjas = Array.isArray(catalog.ninjas) ? catalog.ninjas : [];
  const { existingAtlasZip, chunkZips } = await ensureMainPacks(ninjas);
  await ensureEffectPacks(ninjas, existingAtlasZip, chunkZips);
  cachedTables = await ensureBackupManifestPack(catalog, cachedTables);
  await ensureNinjaSkillsPack(catalog, chunkZips, cachedTables);
}

main().catch((err) => {
  console.error('[ensure-static-packs] Fatal error:', err);
  process.exit(1);
});
