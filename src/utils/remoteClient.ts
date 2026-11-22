import JSZip from 'jszip';
import type {
  ExtractResponse,
  NinjaBundleResponse,
  NinjaEntry,
  NinjaMediaProfile,
  NinjaPassiveInfo,
  NinjaSkillInfo,
  NinjaVideoClip,
  PassiveAuraDef,
  SpineSkeleton,
  SpineVideoEventRef,
} from '../types/sprite';
import {
  extractSpineAudioRefs,
  extractSpineShowFeatureRefs,
  extractSpineVideoRefs,
} from './atlasParser';
import {
  getOfflineMediaProfile,
  getOfflineOrigin,
  getOfflineSonsMap,
  getOfflineZipSnapshot,
  hasOfflineEntry,
  isOfflineBackupActive,
  isStrictOfflineMode,
  readOfflineBlobUrl,
  readOfflineJson,
  readOfflineText,
  resolveOfflineAssetUrlSync,
} from './offlineZipStore';

const CUSTOM_PROXY_KEY = 'shinobi_cors_proxy_url';
const LEGACY_BROKEN_PROXIES = new Set([
  'https://corsproxy.io/?url=',
  'https://corsproxy.io/?',
]);

const FALLBACK_TEXT_PROXIES = [
  'https://api.codetabs.com/v1/proxy?quest=',
  'https://api.allorigins.win/raw?url=',
  'https://api.cors.lol/?url=',
];

let backendStatus: 'unknown' | 'available' | 'static' = 'unknown';

interface IdleMapEntry {
  frame: string;
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  s?: number;
}

interface StaticAtlasPack {
  zip: JSZip;
  idleMap: Record<string, IdleMapEntry>;
}

interface StaticEffectsAtlasPack {
  zip: JSZip;
  chunkMap: Record<string, number>;
  chunkMapLower: Map<string, number>;
}

interface StaticNinjaSkillsEntry {
  heroCode?: string;
  displayName?: string;
  skills?: Record<string, NinjaSkillInfo>;
  passives?: NinjaPassiveInfo[];
}

interface StaticNinjaSkillsPack {
  ninjas: Record<string, StaticNinjaSkillsEntry>;
  ninjasLower: Map<string, StaticNinjaSkillsEntry>;
}

declare const __STATIC_PACK_VERSION__: string | undefined;

let staticPackPromise: Promise<StaticAtlasPack | null> | null = null;
let staticEffectsPackPromise: Promise<StaticEffectsAtlasPack | null> | null = null;
let staticSkillsPackPromise: Promise<StaticNinjaSkillsPack | null> | null = null;
let lastStaticPackError: string | null = null;
const skeletonChunkCache = new Map<number, Promise<JSZip | null>>();
const effectSkeletonChunkCache = new Map<number, Promise<JSZip | null>>();

const STATIC_BASE = import.meta.env.BASE_URL || './';
const STATIC_PACK_VERSION =
  typeof __STATIC_PACK_VERSION__ === 'string' && __STATIC_PACK_VERSION__
    ? __STATIC_PACK_VERSION__
    : 'v2';

function buildStaticDataCandidates(relPath: string): string[] {
  const cleanRel = relPath.replace(/^\/+/, '');
  const withVersion = `${cleanRel}?v=${encodeURIComponent(STATIC_PACK_VERSION)}`;
  const candidates: string[] = [];
  const pushUnique = (u: string) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  if (typeof window !== 'undefined' && window.location?.href) {
    try {
      const baseResolved = new URL(STATIC_BASE, window.location.href);
      pushUnique(new URL(withVersion, baseResolved).toString());
    } catch {
      // ignore invalid base
    }
    try {
      pushUnique(new URL(withVersion, window.location.href).toString());
    } catch {
      // ignore
    }
    try {
      const dirHref = window.location.href.endsWith('/')
        ? window.location.href
        : `${window.location.href.replace(/\/[^/]*$/, '/')}`;
      pushUnique(new URL(withVersion, dirHref).toString());
    } catch {
      // ignore
    }
  }

  pushUnique(`${STATIC_BASE}${withVersion}`);
  pushUnique(`./${withVersion}`);
  return candidates;
}

function hasZipMagicBytes(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 22) return false;
  const view = new Uint8Array(buf, 0, 4);
  return view[0] === 0x50 && view[1] === 0x4b && (view[2] === 0x03 || view[2] === 0x05);
}

export async function fetchStaticZip(
  relPath: string
): Promise<{ zip: JSZip | null; error: string | null }> {
  const candidates = buildStaticDataCandidates(relPath);
  const errors: string[] = [];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) {
        errors.push(`HTTP ${resp.status} em ${url}`);
        continue;
      }
      const buf = await resp.arrayBuffer();
      if (!hasZipMagicBytes(buf)) {
        const ct = resp.headers.get('content-type') || 'desconhecido';
        errors.push(`Resposta não-ZIP (${ct}, ${buf.byteLength}B) em ${url}`);
        continue;
      }
      const zip = await JSZip.loadAsync(buf);
      return { zip, error: null };
    } catch (err) {
      errors.push(`${err instanceof Error ? err.message : 'erro'} em ${url}`);
    }
  }

  return {
    zip: null,
    error: errors[0] || `Falha ao baixar ${relPath}`,
  };
}

async function loadStaticSkeleton(ninjaId: string, chunkIndex: number): Promise<SpineSkeleton | null> {
  let chunkPromise = skeletonChunkCache.get(chunkIndex);
  if (!chunkPromise) {
    chunkPromise = (async () => {
      const { zip } = await fetchStaticZip(`data/skeletons/skel-${chunkIndex}.zip`);
      if (!zip) {
        skeletonChunkCache.delete(chunkIndex);
        return null;
      }
      return zip;
    })();
    skeletonChunkCache.set(chunkIndex, chunkPromise);
  }
  const zip = await chunkPromise;
  if (!zip) return null;
  let file = zip.file(`${ninjaId}.json`);
  if (!file) {
    const lowTarget = `${ninjaId}.json`.toLowerCase();
    for (const [k, v] of Object.entries(zip.files)) {
      if (!v.dir && k.toLowerCase() === lowTarget) {
        file = v;
        break;
      }
    }
  }
  if (!file) return null;
  try {
    return JSON.parse(await file.async('text')) as SpineSkeleton;
  } catch {
    return null;
  }
}

async function loadStaticEffectSkeleton(
  spineId: string,
  chunkIndex: number
): Promise<SpineSkeleton | null> {
  let chunkPromise = effectSkeletonChunkCache.get(chunkIndex);
  if (!chunkPromise) {
    chunkPromise = (async () => {
      const { zip } = await fetchStaticZip(`data/effects-skeletons/eff-${chunkIndex}.zip`);
      if (!zip) {
        effectSkeletonChunkCache.delete(chunkIndex);
        return null;
      }
      return zip;
    })();
    effectSkeletonChunkCache.set(chunkIndex, chunkPromise);
  }
  const zip = await chunkPromise;
  if (!zip) return null;
  let file = zip.file(`${spineId}.json`);
  if (!file) {
    const lowTarget = `${spineId}.json`.toLowerCase();
    for (const [k, v] of Object.entries(zip.files)) {
      if (!v.dir && k.toLowerCase() === lowTarget) {
        file = v;
        break;
      }
    }
  }
  if (!file) return null;
  try {
    return JSON.parse(await file.async('text')) as SpineSkeleton;
  } catch {
    return null;
  }
}

async function loadStaticEffectsAtlasPack(): Promise<StaticEffectsAtlasPack | null> {
  if (!staticEffectsPackPromise) {
    staticEffectsPackPromise = (async () => {
      const { zip } = await fetchStaticZip('data/effects-atlas-pack.zip');
      if (!zip) {
        staticEffectsPackPromise = null;
        return null;
      }
      try {
        const indexFile = zip.file('effects-index.json');
        let chunkMap: Record<string, number> = {};
        if (indexFile) {
          const parsed = JSON.parse(await indexFile.async('text')) as {
            chunks?: Record<string, number>;
          };
          if (parsed?.chunks && typeof parsed.chunks === 'object') {
            chunkMap = parsed.chunks;
          }
        }
        const chunkMapLower = new Map<string, number>();
        for (const [k, v] of Object.entries(chunkMap)) {
          chunkMapLower.set(k.toLowerCase(), v);
        }
        return { zip, chunkMap, chunkMapLower };
      } catch {
        staticEffectsPackPromise = null;
        return null;
      }
    })();
  }
  return staticEffectsPackPromise;
}

export async function loadStaticAtlasPack(): Promise<StaticAtlasPack | null> {
  if (!staticPackPromise) {
    staticPackPromise = (async () => {
      const { zip, error } = await fetchStaticZip('data/naruto-atlas-pack.zip');
      if (!zip) {
        lastStaticPackError = error;
        staticPackPromise = null;
        return null;
      }
      try {
        const idleFile = zip.file('idle-map.json');
        const idleMap: Record<string, IdleMapEntry> = idleFile
          ? (JSON.parse(await idleFile.async('text')) as Record<string, IdleMapEntry>)
          : {};
        lastStaticPackError = null;
        return { zip, idleMap };
      } catch (err) {
        lastStaticPackError = err instanceof Error ? err.message : 'Erro ao ler idle-map.json';
        staticPackPromise = null;
        return null;
      }
    })();
  }
  return staticPackPromise;
}

export async function loadStaticEffectsPack(): Promise<StaticEffectsAtlasPack | null> {
  return loadStaticEffectsAtlasPack();
}

export async function loadStaticNinjaSkillsPack(): Promise<StaticNinjaSkillsPack | null> {
  if (!staticSkillsPackPromise) {
    staticSkillsPackPromise = (async () => {
      const { zip } = await fetchStaticZip('data/ninja-skills-pack.zip');
      if (!zip) {
        staticSkillsPackPromise = null;
        return null;
      }
      try {
        const skillsFile = zip.file('ninja-skills.json');
        if (!skillsFile) {
          staticSkillsPackPromise = null;
          return null;
        }
        const parsed = JSON.parse(await skillsFile.async('text')) as {
          ninjas?: Record<string, StaticNinjaSkillsEntry>;
        };
        const ninjas = parsed?.ninjas && typeof parsed.ninjas === 'object' ? parsed.ninjas : {};
        const ninjasLower = new Map<string, StaticNinjaSkillsEntry>();
        for (const [k, v] of Object.entries(ninjas)) {
          ninjasLower.set(k.toLowerCase(), v);
        }
        return { ninjas, ninjasLower };
      } catch {
        staticSkillsPackPromise = null;
        return null;
      }
    })();
  }
  return staticSkillsPackPromise;
}

function mergeStaticSkillsIntoProfile(
  profile: NinjaMediaProfile,
  entry: StaticNinjaSkillsEntry | undefined
): NinjaMediaProfile {
  if (!entry) return profile;

  const mergedSkills: Record<string, NinjaSkillInfo> = { ...(profile.skills || {}) };
  if (entry.skills) {
    for (const [animKey, staticSkill] of Object.entries(entry.skills)) {
      const existing = mergedSkills[animKey];
      if (!existing) {
        mergedSkills[animKey] = { ...staticSkill };
      } else {
        mergedSkills[animKey] = {
          ...existing,
          iconName: existing.iconName || staticSkill.iconName,
          iconUrl: existing.iconUrl || staticSkill.iconUrl,
          desc: existing.desc || staticSkill.desc,
        };
      }
    }
  }

  let mergedPassives = [...(profile.passives || [])];
  if (entry.passives && entry.passives.length > 0) {
    if (mergedPassives.length === 0) {
      mergedPassives = entry.passives.map((p) => ({ ...p }));
    } else {
      const byId = new Map(entry.passives.map((p) => [p.id, p]));
      mergedPassives = mergedPassives.map((p) => {
        const sp = byId.get(p.id);
        return sp
          ? {
              ...p,
              iconName: p.iconName || sp.iconName,
              iconUrl: p.iconUrl || sp.iconUrl,
              desc: p.desc || sp.desc,
            }
          : p;
      });
    }
  }

  return {
    ...profile,
    heroCode: profile.heroCode || entry.heroCode,
    displayName: profile.displayName || entry.displayName,
    skills: mergedSkills,
    passives: mergedPassives,
  };
}

export async function readStaticPackFileBytes(relPath: string): Promise<Uint8Array | null> {
  const clean = relPath.replace(/^\/+/, '');
  const low = clean.toLowerCase();
  const isSpineDir =
    low.startsWith('acervo/asset/spine/') || low.startsWith('acervo/asset/spine-no-estados/');
  if (!isSpineDir) return null;

  const fileName = clean.split('/').pop() || '';
  const isAtlas = fileName.toLowerCase().endsWith('.atlas');
  const isJson = fileName.toLowerCase().endsWith('.json');
  if (!isAtlas && !isJson) return null;

  const stem = fileName.slice(0, isAtlas ? -6 : -5);
  const stemLow = stem.toLowerCase();

  // Check main atlas/skeleton pack first
  const mainPack = await loadStaticAtlasPack();
  if (mainPack) {
    if (isAtlas) {
      const f = mainPack.zip.file(`atlas/${stem}.atlas`);
      if (f) return await f.async('uint8array');
    } else if (isJson) {
      const idleEntry = mainPack.idleMap[stem];
      if (typeof idleEntry?.s === 'number') {
        const chunkPromise =
          skeletonChunkCache.get(idleEntry.s) ||
          (async () => {
            const { zip } = await fetchStaticZip(`data/skeletons/skel-${idleEntry.s}.zip`);
            return zip;
          })();
        if (!skeletonChunkCache.has(idleEntry.s)) {
          skeletonChunkCache.set(idleEntry.s, chunkPromise);
        }
        const chunkZip = await chunkPromise;
        const sf = chunkZip?.file(`${stem}.json`);
        if (sf) return await sf.async('uint8array');
      }
    }
  }

  // Check companion combat particles pack
  const effPack = await loadStaticEffectsAtlasPack();
  if (effPack) {
    if (isAtlas) {
      let f = effPack.zip.file(`atlas/${stem}.atlas`);
      if (!f) {
        const target = `atlas/${stemLow}.atlas`;
        for (const [k, v] of Object.entries(effPack.zip.files)) {
          if (!v.dir && k.toLowerCase() === target) {
            f = v;
            break;
          }
        }
      }
      if (f) return await f.async('uint8array');
    } else if (isJson) {
      const chunkIdx = effPack.chunkMap[stem] ?? effPack.chunkMapLower.get(stemLow);
      if (typeof chunkIdx === 'number') {
        let chunkPromise = effectSkeletonChunkCache.get(chunkIdx);
        if (!chunkPromise) {
          chunkPromise = (async () => {
            const { zip } = await fetchStaticZip(`data/effects-skeletons/eff-${chunkIdx}.zip`);
            if (!zip) {
              effectSkeletonChunkCache.delete(chunkIdx);
              return null;
            }
            return zip;
          })();
          effectSkeletonChunkCache.set(chunkIdx, chunkPromise);
        }
        const chunkZip = await chunkPromise;
        if (chunkZip) {
          let sf = chunkZip.file(`${stem}.json`);
          if (!sf) {
            const target = `${stemLow}.json`;
            for (const [k, v] of Object.entries(chunkZip.files)) {
              if (!v.dir && k.toLowerCase() === target) {
                sf = v;
                break;
              }
            }
          }
          if (sf) return await sf.async('uint8array');
        }
      }
    }
  }

  return null;
}

export async function fetchStaticCatalogJson(): Promise<ExtractResponse | null> {
  for (const candidateUrl of buildStaticDataCandidates('data/naruto-catalog.json')) {
    try {
      const resp = await fetch(candidateUrl, { cache: 'no-cache' });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.trimStart().startsWith('<')) continue;
      return JSON.parse(text) as ExtractResponse;
    } catch {
      // try next
    }
  }
  return null;
}

export function getSavedCorsProxy(): string {
  try {
    const val = (localStorage.getItem(CUSTOM_PROXY_KEY) ?? '').trim();
    if (!val || LEGACY_BROKEN_PROXIES.has(val)) return '';
    return val;
  } catch {
    return '';
  }
}

export function setSavedCorsProxy(url: string) {
  try {
    const trimmed = url.trim();
    if (!trimmed || LEGACY_BROKEN_PROXIES.has(trimmed)) {
      localStorage.removeItem(CUSTOM_PROXY_KEY);
    } else {
      localStorage.setItem(CUSTOM_PROXY_KEY, trimmed);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function isStaticHostingMode(): boolean {
  return backendStatus === 'static';
}

export function markStaticHostingMode(): void {
  backendStatus = 'static';
}

export function buildCorsRelayUrl(targetUrl: string, proxyPrefix = getSavedCorsProxy()): string {
  const cleanPrefix = proxyPrefix.trim();
  if (!cleanPrefix) return targetUrl;
  if (cleanPrefix.includes('{url}')) {
    return cleanPrefix.replace('{url}', encodeURIComponent(targetUrl));
  }
  return `${cleanPrefix}${encodeURIComponent(targetUrl)}`;
}

export function buildWsrvImageUrl(targetUrl: string): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&ll`;
}

export function resolveAssetFetchUrl(targetUrl: string): string {
  if (!targetUrl) return '';
  if (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')) {
    return targetUrl;
  }

  if (isOfflineBackupActive()) {
    const offlineUrl = resolveOfflineAssetUrlSync(targetUrl);
    if (offlineUrl) return offlineUrl;
    if (isStrictOfflineMode()) return '';
  }

  if (backendStatus !== 'static') {
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  }

  const customProxy = getSavedCorsProxy();
  if (customProxy) {
    return buildCorsRelayUrl(targetUrl, customProxy);
  }

  if (/\.(webp|png|jpe?g|gif)(\?|$)/i.test(targetUrl)) {
    return buildWsrvImageUrl(targetUrl);
  }

  return buildCorsRelayUrl(targetUrl, FALLBACK_TEXT_PROXIES[0]);
}

export function getNinjaThumbUrl(atlasUrl: string, skeletonUrl: string): string | null {
  if (isOfflineBackupActive()) {
    return null;
  }
  if (backendStatus === 'static') {
    return null;
  }
  return `/api/ninja-thumb?atlasUrl=${encodeURIComponent(atlasUrl)}&skeletonUrl=${encodeURIComponent(skeletonUrl)}`;
}

export async function resolveStaticNinjaThumbUrl(ninja: NinjaEntry): Promise<string | null> {
  if (isOfflineBackupActive()) {
    return null;
  }
  const pack = await loadStaticAtlasPack();
  if (!pack) return null;
  const entry = pack.idleMap[ninja.id];
  if (!entry || !entry.page || entry.w <= 0 || entry.h <= 0) return null;

  try {
    const pageUrl = new URL(entry.page, ninja.atlasUrl).toString();
    const customProxy = getSavedCorsProxy();
    if (customProxy) {
      return null;
    }
    const rotateParam = entry.r === 90 ? '&ro=270' : '';
    // Do NOT pass &w=&h= alongside &cx=&cy=&cw=&ch= because wsrv.nl resizes before cropping.
    return `https://wsrv.nl/?url=${encodeURIComponent(pageUrl)}&cx=${entry.x}&cy=${entry.y}&cw=${entry.w}&ch=${entry.h}${rotateParam}&output=png`;
  } catch {
    return null;
  }
}

function parseAtlasPageFilenames(atlasText: string): string[] {
  const lines = atlasText.split(/\r?\n/);
  const pages: string[] = [];
  let expectPageName = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      expectPageName = true;
      continue;
    }
    if (expectPageName) {
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(line)) {
        pages.push(line);
      }
      expectPageName = false;
    }
  }
  return pages;
}

function extractNinjaIdFromAtlasUrl(atlasUrl: string): string | null {
  const clean = atlasUrl.split('?')[0];
  const file = clean.split('/').pop() || '';
  if (!file.toLowerCase().endsWith('.atlas')) return null;
  return file.slice(0, -'.atlas'.length);
}

async function fetchTextViaRelays(targetUrl: string, timeoutMs = 6000): Promise<Response | null> {
  const custom = getSavedCorsProxy();
  const prefixes = custom ? [custom, ...FALLBACK_TEXT_PROXIES] : FALLBACK_TEXT_PROXIES;

  for (const prefix of prefixes) {
    try {
      const resp = await fetch(buildCorsRelayUrl(targetUrl, prefix), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        return resp;
      }
    } catch {
      // try next relay
    }
  }
  return null;
}

export async function extractGameCatalog(targetUrl: string): Promise<ExtractResponse> {
  // Try backend API first (works in Node/Express dev & Cloud Run)
  if (backendStatus !== 'static') {
    try {
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        backendStatus = 'available';
        const data = (await resp.json()) as ExtractResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Não foi possível extrair os sprites desta URL.');
        }
        return data;
      }
      backendStatus = 'static';
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.includes('Failed to fetch') &&
        backendStatus === 'available'
      ) {
        throw err;
      }
      backendStatus = 'static';
    }
  }

  // Static / GitHub Pages fallback
  const normalized = targetUrl.toLowerCase();
  if (normalized.includes('naruto.jotagame.com')) {
    for (const candidateUrl of buildStaticDataCandidates('data/naruto-catalog.json')) {
      try {
        const staticResp = await fetch(candidateUrl, { cache: 'no-cache' });
        if (!staticResp.ok) continue;
        const ct = staticResp.headers.get('content-type') || '';
        const text = await staticResp.text();
        if (ct.includes('text/html') || text.trimStart().startsWith('<')) continue;
        return JSON.parse(text) as ExtractResponse;
      } catch {
        // try next candidate
      }
    }
  }

  // Attempt client-side fetch via configured CORS relay for other URLs
  const htmlResp = await fetchTextViaRelays(targetUrl, 8000);
  if (!htmlResp) {
    throw new Error(
      'Modo estático (GitHub Pages): configure um Proxy CORS ou use o catálogo pré-carregado de naruto.jotagame.com.'
    );
  }
  const html = await htmlResp.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const imgs = Array.from(
    html.matchAll(/(?:src|href)=["']([^"']+\.(?:png|webp|jpe?g|gif|svg)(?:\?[^"']*)?)["']/gi)
  ).map((m) => {
    const resolved = new URL(m[1], targetUrl).toString();
    const name = resolved.split('?')[0].split('/').pop() || 'sprite';
    const ext = name.split('.').pop()?.toLowerCase() || 'png';
    return { name, url: resolved, category: 'sprite' as const, ext };
  });

  return {
    sourceUrl: targetUrl,
    resolvedGameUrl: targetUrl,
    gameTitle: titleMatch ? titleMatch[1].trim() : 'Jogo Web',
    ninjas: [],
    sheets: [],
    assets: imgs,
    stats: {
      scannedScripts: 0,
      discoveredAssets: imgs.length,
      totalNinjas: 0,
      totalSheets: 0,
      elapsedMs: 0,
    },
  };
}

export async function fetchNinjaBundle(
  atlasUrl: string,
  skeletonUrl: string,
  options?: { skipSkeleton?: boolean }
): Promise<NinjaBundleResponse> {
  // Offline local ZIP backup path (zero RAM overhead via File.slice)
  if (isOfflineBackupActive()) {
    const offlineAtlas = await readOfflineText(atlasUrl);
    if (offlineAtlas) {
      const skeleton =
        !options?.skipSkeleton && skeletonUrl
          ? await readOfflineJson<SpineSkeleton>(skeletonUrl)
          : null;

      const pageFilenames = parseAtlasPageFilenames(offlineAtlas);
      const pageUrls: Record<string, string> = {};
      for (const pageFile of pageFilenames) {
        const resolved = new URL(pageFile, atlasUrl).toString();
        const blobUrl = await readOfflineBlobUrl(resolved);
        if (blobUrl) {
          pageUrls[pageFile] = blobUrl;
        } else if (!isStrictOfflineMode()) {
          pageUrls[pageFile] = resolveAssetFetchUrl(resolved);
        }
      }

      return {
        atlasText: offlineAtlas,
        skeleton,
        pageUrls,
      };
    }

    if (isStrictOfflineMode()) {
      const fileLabel = atlasUrl.split('/').pop() || atlasUrl;
      throw new Error(
        `Arquivo "${fileLabel}" não encontrado nos ZIPs carregados (Modo 100% Offline). Adicione a parte correspondente na aba Backup Offline.`
      );
    }
  }

  if (backendStatus !== 'static') {
    try {
      const resp = await fetch(
        `/api/ninja-bundle?atlasUrl=${encodeURIComponent(atlasUrl)}&skeletonUrl=${encodeURIComponent(skeletonUrl)}`
      );
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        backendStatus = 'available';
        const data = (await resp.json()) as NinjaBundleResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Falha ao carregar pacote do ninja.');
        }
        return data;
      }
      backendStatus = 'static';
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.includes('Failed to fetch') &&
        backendStatus === 'available'
      ) {
        throw err;
      }
      backendStatus = 'static';
    }
  }

  // Static GitHub Pages mode: first try bundled compressed atlas & skeleton packs (zero rate limits!)
  const ninjaId = extractNinjaIdFromAtlasUrl(atlasUrl);
  let atlasText = '';
  let idleFrameName: string | undefined;
  let skeletonChunkIdx: number | undefined;
  let effectSkeletonChunkIdx: number | undefined;
  let staticDiagReason = '';

  if (ninjaId) {
    const pack = await loadStaticAtlasPack();
    if (!pack) {
      staticDiagReason = lastStaticPackError
        ? `Pacote estático indisponível (${lastStaticPackError})`
        : 'Pacote estático data/naruto-atlas-pack.zip indisponível';
    } else {
      let packedAtlas = pack.zip.file(`atlas/${ninjaId}.atlas`) ?? null;
      let resolvedId = ninjaId;
      if (!packedAtlas) {
        const targetLow = `atlas/${ninjaId}.atlas`.toLowerCase();
        for (const [k, v] of Object.entries(pack.zip.files)) {
          if (!v.dir && k.toLowerCase() === targetLow) {
            packedAtlas = v;
            resolvedId = k.slice('atlas/'.length, -'.atlas'.length);
            break;
          }
        }
      }
      if (packedAtlas) {
        atlasText = await packedAtlas.async('text');
        const entry = pack.idleMap[resolvedId] || pack.idleMap[ninjaId];
        idleFrameName = entry?.frame;
        skeletonChunkIdx = entry?.s;
      } else {
        // Fallback to companion combat particle/effect static pack
        const effectsPack = await loadStaticEffectsAtlasPack();
        if (effectsPack) {
          let effAtlas = effectsPack.zip.file(`atlas/${ninjaId}.atlas`) ?? null;
          let effResolvedId = ninjaId;
          if (!effAtlas) {
            const targetLow = `atlas/${ninjaId}.atlas`.toLowerCase();
            for (const [k, v] of Object.entries(effectsPack.zip.files)) {
              if (!v.dir && k.toLowerCase() === targetLow) {
                effAtlas = v;
                effResolvedId = k.slice('atlas/'.length, -'.atlas'.length);
                break;
              }
            }
          }
          if (effAtlas) {
            atlasText = await effAtlas.async('text');
            effectSkeletonChunkIdx =
              effectsPack.chunkMap[effResolvedId] ??
              effectsPack.chunkMap[ninjaId] ??
              effectsPack.chunkMapLower.get(ninjaId.toLowerCase());
          }
        }
        if (!atlasText) {
          const totalPacked = Object.keys(pack.idleMap).length;
          staticDiagReason = `"${ninjaId}.atlas" ausente nos pacotes estáticos (${totalPacked} ninjas carregados)`;
        }
      }
    }
  } else {
    staticDiagReason = `ID de atlas não reconhecido em "${atlasUrl}"`;
  }

  if (!atlasText) {
    const atlasResp = await fetchTextViaRelays(atlasUrl, 7000);
    if (!atlasResp) {
      const detail = staticDiagReason ? ` [${staticDiagReason}]` : '';
      throw new Error(
        `Não foi possível carregar o .atlas em modo estático.${detail} Use a aba "Backup Offline" para abrir seu arquivo .zip local ou configure um Proxy CORS próprio.`
      );
    }
    atlasText = await atlasResp.text();
  }

  let skeleton: SpineSkeleton | null = null;
  if (!options?.skipSkeleton) {
    if (ninjaId && typeof skeletonChunkIdx === 'number') {
      skeleton = await loadStaticSkeleton(ninjaId, skeletonChunkIdx);
    } else if (ninjaId && typeof effectSkeletonChunkIdx === 'number') {
      skeleton = await loadStaticEffectSkeleton(ninjaId, effectSkeletonChunkIdx);
    }
    if (!skeleton && skeletonUrl) {
      const skelResp = await fetchTextViaRelays(skeletonUrl, 4500);
      if (skelResp) {
        try {
          skeleton = (await skelResp.json()) as SpineSkeleton;
        } catch {
          skeleton = null;
        }
      }
    }
  }

  const pageFilenames = parseAtlasPageFilenames(atlasText);
  const pageUrls: Record<string, string> = {};
  const customProxy = getSavedCorsProxy();
  for (const pageFile of pageFilenames) {
    const resolved = new URL(pageFile, atlasUrl).toString();
    pageUrls[pageFile] = customProxy
      ? buildCorsRelayUrl(resolved, customProxy)
      : buildWsrvImageUrl(resolved);
  }

  return { atlasText, skeleton, pageUrls, idleFrameName };
}

function getOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'https://naruto.jotagame.com';
  }
}

export function resolveFallbackPassiveAura(ninja: NinjaEntry): PassiveAuraDef | null {
  const origin = getOriginFromUrl(ninja.atlasUrl);
  const idLower = (ninja.id || '').toLowerCase();
  const code = (ninja.code || '').replace(/^vdfno_/i, '');
  const numericCode =
    code.match(/(\d{4,6})/)?.[1] || idLower.match(/(\d{4,6})/)?.[1] || '';

  const makeEstado = (
    id: string,
    label: string,
    layers: PassiveAuraDef['layers']
  ): PassiveAuraDef => ({
    id,
    label,
    atlasUrl: `${origin}/acervo/asset/spine-no-estados/${id}.atlas`,
    skeletonUrl: `${origin}/acervo/asset/spine-no-estados/${id}.json`,
    layers,
  });

  if (
    numericCode === '100038' ||
    numericCode === '100306' ||
    idLower === 'vdfno_100306' ||
    idLower === 'zuozhuxiao' ||
    (idLower !== 'dyyjiaodu' && /susano/i.test(ninja.name || ''))
  ) {
    return makeEstado('noe_ZUOZHUXZbati', "Armadura: Susano'o", [
      { layer: 'front', introAnim: 'b1', loopAnim: 'b2', outroAnim: 'b3' },
    ]);
  }

  if (numericCode === '100050' || numericCode === '100365' || idLower === 'renzhankakaxi') {
    return makeEstado('noe_Banzhongyanzhizhan_bati', 'Armadura: Susano’o (Kakashi)', [
      { layer: 'front', loopAnim: 'shang' },
    ]);
  }

  if (numericCode === '100569') {
    return makeEstado('noe_Youzhongguofeng_beidong', 'Aura Passiva (Itachi)', [
      { layer: 'front', introAnim: 'b1', loopAnim: 'b2', outroAnim: 'b3' },
    ]);
  }

  if (numericCode === '100637') {
    return {
      id: 'noe_yuehziyan_daiji',
      label: 'Aura Passiva (Tsukuyomi)',
      atlasUrl: `${origin}/acervo/asset/spine/noe_yuehziyan_daiji.atlas`,
      skeletonUrl: `${origin}/acervo/asset/spine/noe_yuehziyan_daiji.json`,
      layers: [
        { layer: 'behind', loopAnim: 'xia' },
        { layer: 'front', loopAnim: 'shang' },
      ],
    };
  }

  if (numericCode === '100640') {
    return makeEstado('noe_Yuzhibozhishuizhongguofeng_beidong', 'Aura Passiva (Shisui)', [
      { layer: 'behind', introAnim: 'b1xia', loopAnim: 'b2xia', outroAnim: 'b3xia' },
      { layer: 'front', introAnim: 'b1shang', loopAnim: 'b2shang', outroAnim: 'b3shang' },
    ]);
  }

  if (numericCode === '100673') {
    return makeEstado('noe_xuzuobanbati', "Armadura: Susano'o (Madara)", [
      {
        layer: 'front',
        introAnim: 'xuzuobanbati_kaiqi',
        loopAnim: 'xuzuobanbati_chixu',
        outroAnim: 'xuzuobanbati_jiesu',
      },
    ]);
  }

  return null;
}

export function resolveMediaSoundUrl(
  soundName: string,
  mediaProfile: NinjaMediaProfile | null | undefined,
  atlasUrl: string
): string | null {
  const clean = soundName.trim().replace(/\.mp3$/i, '');
  if (!clean) return null;

  const direct = mediaProfile?.soundUrlMap?.[clean] || mediaProfile?.soundUrlMap?.[soundName];
  if (direct) return direct;

  const origin = mediaProfile?.originBase || getOriginFromUrl(atlasUrl);
  if (/^nos_/i.test(clean)) {
    return `${origin}/acervo/som/nos/${clean.slice(4)}.mp3`;
  }
  if (/^Die_/i.test(clean)) {
    return `${origin}/acervo/som/Die/${clean}.mp3`;
  }
  return `${origin}/acervo/som/${clean}.mp3`;
}

export function resolveMediaVideoUrl(
  videoRef: Pick<SpineVideoEventRef, 'source' | 'resolvedName'>,
  mediaProfile: NinjaMediaProfile | null | undefined,
  atlasUrl: string
): string | null {
  const map = mediaProfile?.videoUrlMap;
  if (map) {
    if (map[videoRef.resolvedName]) return map[videoRef.resolvedName];
    if (map[videoRef.source]) return map[videoRef.source];
    const targetLow = (videoRef.resolvedName || videoRef.source || '').toLowerCase();
    for (const [k, url] of Object.entries(map)) {
      if (k.toLowerCase() === targetLow) return url;
    }
  }
  const origin = mediaProfile?.originBase || getOriginFromUrl(atlasUrl);
  const key = (videoRef.resolvedName || videoRef.source || '').trim().replace(/\.mp4$/i, '');
  if (!key) return null;
  return `${origin}/acervo/video/hero/${key}.mp4`;
}

const mediaProfileCache = new Map<string, Promise<NinjaMediaProfile>>();

function buildFallbackMediaProfile(
  ninja: NinjaEntry,
  skeleton: SpineSkeleton | null | undefined
): NinjaMediaProfile {
  const originBase = getOriginFromUrl(ninja.atlasUrl);
  const soundUrlMap: Record<string, string> = {};
  const videoUrlMap: Record<string, string> = {};
  const videos: NinjaVideoClip[] = [];
  const seenVideo = new Set<string>();

  if (skeleton?.animations) {
    for (const animName of Object.keys(skeleton.animations)) {
      for (const sRef of extractSpineAudioRefs(skeleton, animName)) {
        const clean = sRef.soundName.replace(/\.mp3$/i, '');
        if (!soundUrlMap[clean]) {
          const url = resolveMediaSoundUrl(clean, null, ninja.atlasUrl);
          if (url) soundUrlMap[clean] = url;
        }
      }
      for (const vRef of extractSpineVideoRefs(skeleton, animName)) {
        const key = vRef.resolvedName.replace(/\.mp4$/i, '');
        const url = `${originBase}/acervo/video/hero/${key}.mp4`;
        videoUrlMap[key] = url;
        videoUrlMap[vRef.source] = url;
        if (!seenVideo.has(key)) {
          seenVideo.add(key);
          videos.push({
            key,
            label: `Ultimate (${animName})`,
            kind: 'ultimate',
            animName,
            startTime: vRef.time,
            url,
          });
        }
      }
    }
  }

  return {
    ninjaId: ninja.id,
    heroCode: ninja.code,
    displayName: ninja.name,
    skills: {},
    passives: [],
    passiveAura: resolveFallbackPassiveAura(ninja),
    videos,
    voices: [],
    soundUrlMap,
    videoUrlMap,
    originBase,
  };
}

export function clearMediaProfileCache() {
  mediaProfileCache.clear();
}

export async function fetchNinjaMediaProfile(
  ninja: NinjaEntry,
  skeleton: SpineSkeleton | null | undefined
): Promise<NinjaMediaProfile> {
  const offlineSnap = getOfflineZipSnapshot();
  const cacheKey = `${offlineSnap.active ? `zip:${offlineSnap.generation}` : 'net'}::${ninja.id}::${ninja.atlasUrl}`;
  const cached = mediaProfileCache.get(cacheKey);
  if (cached) return cached;

  const task = (async (): Promise<NinjaMediaProfile> => {
    const soundNames = new Set<string>();
    const videoNames = new Set<string>();
    const featureNames = new Set<string>();
    const videoByAnim = new Map<string, { animName: string; startTime: number }>();
    const showFeatures: Array<{ animName: string; startTime: number; files: string[] }> = [];

    const availableAnims = skeleton?.animations ? Object.keys(skeleton.animations) : [];
    if (skeleton?.animations) {
      for (const animName of availableAnims) {
        for (const sRef of extractSpineAudioRefs(skeleton, animName)) {
          soundNames.add(sRef.soundName);
        }
        for (const vRef of extractSpineVideoRefs(skeleton, animName)) {
          videoNames.add(vRef.resolvedName);
          if (vRef.source !== vRef.resolvedName) videoNames.add(vRef.source);
          const lowResolved = vRef.resolvedName.toLowerCase();
          const lowSource = vRef.source.toLowerCase();
          if (!videoByAnim.has(lowResolved)) {
            videoByAnim.set(lowResolved, { animName, startTime: vRef.time });
          }
          if (!videoByAnim.has(lowSource)) {
            videoByAnim.set(lowSource, { animName, startTime: vRef.time });
          }
        }
        for (const sfRef of extractSpineShowFeatureRefs(skeleton, animName)) {
          for (const f of sfRef.files) featureNames.add(f);
          showFeatures.push({ animName, startTime: sfRef.time, files: sfRef.files });
        }
      }
    }

    const preferredShowFeature =
      showFeatures.find((sf) => sf.animName === 'UniqueSkill') ||
      showFeatures.find((sf) => sf.animName.toLowerCase().includes('unique')) ||
      showFeatures[0];

    const fallbackUltimateAnim =
      availableAnims.find((a) => a === 'UniqueSkill') ||
      availableAnims.find((a) => a === 'UniqueSkill2') ||
      availableAnims.find((a) => a.toLowerCase() === 'uniqueskill') ||
      availableAnims.find((a) => a === 'superUniqueSkill');

    const attachVideoAnimTiming = (videosList: NinjaVideoClip[]): NinjaVideoClip[] =>
      videosList.map((v) => {
        if (v.animName) return v;
        const keyLow = v.key.toLowerCase();
        const directMeta =
          videoByAnim.get(keyLow) ||
          videoByAnim.get(keyLow.replace(/_(left|right)$/i, ''));
        if (directMeta) {
          return { ...v, animName: directMeta.animName, startTime: directMeta.startTime };
        }
        if (v.kind === 'ultimate') {
          if (preferredShowFeature) {
            return {
              ...v,
              animName: preferredShowFeature.animName,
              startTime: preferredShowFeature.startTime,
            };
          }
          if (fallbackUltimateAnim) {
            return {
              ...v,
              animName: fallbackUltimateAnim,
              startTime: 0.25,
            };
          }
        }
        return v;
      });

    // Offline local ZIP mode: resolve profile 100% locally with zero backend requests
    if (offlineSnap.active) {
      const originBase = getOfflineOrigin() || getOriginFromUrl(ninja.atlasUrl);
      const sonsMap = getOfflineSonsMap();
      const stored = getOfflineMediaProfile(ninja.id);
      const baseProfile: NinjaMediaProfile = stored
        ? {
            ...stored,
            soundUrlMap: { ...(stored.soundUrlMap || {}) },
            videoUrlMap: { ...(stored.videoUrlMap || {}) },
            videos: [...(stored.videos || [])],
            voices: [...(stored.voices || [])],
          }
        : buildFallbackMediaProfile(ninja, skeleton);

      // Enrich any skeleton @CMD sounds from offline sons.json or direct ZIP lookup
      for (const rawSound of soundNames) {
        const clean = rawSound.trim().replace(/\.mp3$/i, '');
        if (!clean || baseProfile.soundUrlMap[clean]) continue;
        const mapped = sonsMap[clean];
        if (typeof mapped === 'string' && mapped) {
          baseProfile.soundUrlMap[clean] = `${originBase}/${mapped.replace(/^\/+/, '')}`;
          continue;
        }
        const candidates = [
          clean.startsWith('nos_') ? `acervo/som/nos/${clean.slice(4)}.mp3` : '',
          clean.toLowerCase().startsWith('die_') ? `acervo/som/Die/${clean}.mp3` : '',
          `acervo/som/${clean}.mp3`,
          `acervo/som/lines/${clean}.mp3`,
          `acervo/som/AFaoyi/${clean}.mp3`,
        ].filter(Boolean);
        const found = candidates.find((c) => hasOfflineEntry(c));
        if (found) {
          baseProfile.soundUrlMap[clean] = `${originBase}/${found}`;
        }
      }

      // Enrich any skeleton {PLAYVEDIO} clips if not already listed
      const seenVidKeys = new Set(baseProfile.videos.map((v) => v.key.toLowerCase()));
      for (const rawVid of videoNames) {
        const clean = rawVid.trim().replace(/\.mp4$/i, '');
        if (!clean || seenVidKeys.has(clean.toLowerCase())) continue;
        const candidates = [
          `acervo/video/hero/${clean}.mp4`,
          `acervo/video/hero/${clean}_left.mp4`,
          `acervo/video/recruit/${clean}.mp4`,
        ];
        const found = candidates.find((c) => hasOfflineEntry(c));
        if (found) {
          const url = `${originBase}/${found}`;
          baseProfile.videoUrlMap[clean] = url;
          seenVidKeys.add(clean.toLowerCase());
          baseProfile.videos.push({
            key: clean,
            label: `Vídeo Ultimate (${clean})`,
            kind: found.includes('/recruit/') ? 'recruit' : 'ultimate',
            url,
          });
        }
      }

      let finalOfflineProfile: NinjaMediaProfile = {
        ...baseProfile,
        passiveAura: baseProfile.passiveAura ?? resolveFallbackPassiveAura(ninja),
        videos: attachVideoAnimTiming(baseProfile.videos),
      };

      // Enrich skill icons from bundled static skills pack if an older offline ZIP lacks iconUrl
      const hasAnyOfflineIcon =
        Object.values(finalOfflineProfile.skills || {}).some((s) => Boolean(s.iconUrl)) ||
        (finalOfflineProfile.passives || []).some((p) => Boolean(p.iconUrl));
      if (!hasAnyOfflineIcon) {
        const skillsPack = await loadStaticNinjaSkillsPack();
        const staticEntry =
          skillsPack?.ninjas[ninja.id] || skillsPack?.ninjasLower.get(ninja.id.toLowerCase());
        if (staticEntry) {
          finalOfflineProfile = mergeStaticSkillsIntoProfile(finalOfflineProfile, staticEntry);
        }
      }

      return finalOfflineProfile;
    }

    if (backendStatus !== 'static') {
      try {
        const params = new URLSearchParams({
          id: ninja.id,
          code: ninja.code || '',
          atlasUrl: ninja.atlasUrl,
        });
        if (ninja.name) params.set('name', ninja.name);
        if (soundNames.size > 0) {
          params.set('sounds', Array.from(soundNames).slice(0, 120).join(','));
        }
        if (videoNames.size > 0) {
          params.set('videos', Array.from(videoNames).slice(0, 20).join(','));
        }
        if (featureNames.size > 0) {
          params.set('features', Array.from(featureNames).slice(0, 20).join(','));
        }

        const resp = await fetch(`/api/ninja-media?${params.toString()}`);
        const contentType = resp.headers.get('content-type') || '';
        if (resp.ok && contentType.includes('application/json')) {
          backendStatus = 'available';
          const data = (await resp.json()) as NinjaMediaProfile;
          return {
            ...data,
            passiveAura: data.passiveAura ?? resolveFallbackPassiveAura(ninja),
            videos: attachVideoAnimTiming(data.videos || []),
          };
        }
        if (!contentType.includes('application/json')) {
          backendStatus = 'static';
        }
      } catch {
        // fall through to local deterministic profile + static skills pack
      }
    }

    let fallbackProfile = buildFallbackMediaProfile(ninja, skeleton);
    const skillsPack = await loadStaticNinjaSkillsPack();
    const staticEntry =
      skillsPack?.ninjas[ninja.id] || skillsPack?.ninjasLower.get(ninja.id.toLowerCase());
    if (staticEntry) {
      fallbackProfile = mergeStaticSkillsIntoProfile(fallbackProfile, staticEntry);
    }
    return fallbackProfile;
  })();

  if (mediaProfileCache.size >= 40) {
    const oldest = mediaProfileCache.keys().next().value;
    if (oldest) mediaProfileCache.delete(oldest);
  }
  mediaProfileCache.set(cacheKey, task);
  return task;
}
