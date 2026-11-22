import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  registerBackupRoutes,
  type BackupExtractPayload,
  type BackupTablesLike,
} from './serverBackup.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_PROXY_BYTES = 24 * 1024 * 1024;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    }
    return false;
  }
  return true;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  const trimmed = rawUrl.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error('URL inválida. Informe um endereço http:// ou https:// válido.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas protocolos HTTP e HTTPS são permitidos.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    throw new Error('Endereços locais ou internos não são permitidos.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Endereços de rede privada não são permitidos.');
    }
    return parsed;
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) {
      throw new Error('O domínio resolve para um endereço privado não permitido.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('não permitido')) {
      throw err;
    }
    throw new Error(`Não foi possível resolver o domínio "${hostname}".`);
  }

  return parsed;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 10000,
  accept = '*/*',
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        ...(extraHeaders || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function resolveRelativeUrl(baseUrl: string, ref: string): string | null {
  if (!ref || ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('javascript:')) {
    return null;
  }
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return null;
  }
}

function categorizeAsset(
  urlStr: string
): 'emoji' | 'hero' | 'item' | 'ui' | 'bg' | 'sprite' | 'other' {
  const lower = urlStr.toLowerCase();
  if (lower.includes('vdf-emoji') || lower.includes('/emoji')) {
    return 'emoji';
  }
  if (lower.includes('/heros/') || lower.includes('/expression/') || lower.includes('/fichano/')) {
    return 'hero';
  }
  if (lower.includes('/spine/') || lower.includes('/hero') || lower.includes('ninja') || lower.includes('character')) {
    return 'sprite';
  }
  if (
    lower.includes('/items/') ||
    lower.includes('item_') ||
    lower.includes('/rune/') ||
    lower.includes('icone') ||
    lower.includes('icon')
  ) {
    return 'item';
  }
  if (
    lower.includes('/bg/') ||
    lower.includes('bg_') ||
    lower.includes('adventurebg') ||
    lower.includes('moldura') ||
    lower.includes('banner')
  ) {
    return 'bg';
  }
  if (
    lower.includes('/ui/') ||
    lower.includes('/templo/') ||
    lower.includes('/titulos-no/') ||
    lower.includes('/barra-no/') ||
    lower.includes('/chat-no/') ||
    lower.includes('vipplacas') ||
    lower.includes('botao') ||
    lower.includes('titulo')
  ) {
    return 'ui';
  }
  return 'other';
}

function classifySpinePackageKind(id: string): 'character' | 'summon_skin' | 'effect' {
  const lower = id.toLowerCase();
  if (lower.startsWith('vdfno_')) return 'character';
  if (
    lower.endsWith('_effect') ||
    lower.endsWith('_highteffect') ||
    lower.endsWith('_ground') ||
    lower.includes('huomiao')
  ) {
    return 'effect';
  }
  return 'summon_skin';
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : 'Jogo Web';
}

function detectGameEntrypoints(html: string, baseUrl: string): string[] {
  const candidates: string[] = [];

  // Detect conditional JS redirect targets like: location.replace(instalado?"jogar?app=1":"...")
  const replaceMatches = html.matchAll(/location\.(?:replace|assign|href\s*=)\s*\(?\s*([^;)\n]+)/gi);
  for (const m of replaceMatches) {
    const expr = m[1];
    const stringLiterals = expr.matchAll(/['"]([^'"]+)['"]/g);
    for (const s of stringLiterals) {
      const target = s[1].trim();
      if (!target) continue;
      const resolved = resolveRelativeUrl(baseUrl, target);
      if (resolved) candidates.push(resolved);
    }
  }

  // Detect meta refresh
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s;>]+)/i);
  if (metaRefresh?.[1]) {
    const resolved = resolveRelativeUrl(baseUrl, metaRefresh[1]);
    if (resolved) candidates.push(resolved);
  }

  return Array.from(new Set(candidates));
}

function extractReferencesFromHtml(html: string, baseUrl: string) {
  const entryScriptUrls = new Set<string>();
  const importMapScriptUrls = new Set<string>();
  const cssUrls = new Set<string>();
  const imageUrls = new Set<string>();
  const jsonUrls = new Set<string>();

  // <script src="..."> (always prioritize entry modules)
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (resolved) entryScriptUrls.add(resolved);
  }

  // Parse importmap JSON if present
  const importMapMatches = html.matchAll(/<script[^>]+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of importMapMatches) {
    try {
      const parsed = JSON.parse(m[1]) as { imports?: Record<string, string> };
      if (parsed.imports) {
        for (const val of Object.values(parsed.imports)) {
          const resolved = resolveRelativeUrl(baseUrl, val);
          if (resolved && !entryScriptUrls.has(resolved)) importMapScriptUrls.add(resolved);
        }
      }
    } catch {
      // ignore malformed importmap
    }
  }

  const scriptUrls = new Set<string>([...entryScriptUrls, ...importMapScriptUrls]);

  // <link href="...">
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0].toLowerCase();
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (!resolved) continue;
    if (tag.includes('stylesheet')) cssUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg|ico)(\?|$)/i.test(resolved)) imageUrls.add(resolved);
  }

  // <img src|data-src> & <source srcset>
  for (const m of html.matchAll(/(?:src|data-src|href)=["']([^"']+\.(?:png|webp|jpe?g|gif|svg)(?:\?[^"']*)?)["']/gi)) {
    const resolved = resolveRelativeUrl(baseUrl, m[1]);
    if (resolved) imageUrls.add(resolved);
  }

  // Inline JS & CSS strings
  for (const m of html.matchAll(/['"`]([a-zA-Z0-9_./-]+\.(?:png|webp|jpe?g|gif|svg|json|atlas)(?:\?[^'"`]*)?)['"`]/gi)) {
    const ref = m[1];
    const resolved = resolveRelativeUrl(baseUrl, ref);
    if (!resolved) continue;
    if (/\.(json)(\?|$)/i.test(ref)) jsonUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg)(\?|$)/i.test(ref)) imageUrls.add(resolved);
  }

  return { scriptUrls, cssUrls, imageUrls, jsonUrls };
}

function extractPathsFromCode(code: string, baseUrl: string) {
  const imageUrls = new Set<string>();
  const jsonUrls = new Set<string>();

  const pattern = /['"`]([a-zA-Z0-9_./-]*\/[a-zA-Z0-9_./-]+\.(?:png|webp|jpe?g|gif|svg|json|atlas))(?:\?[^'"`]*)?['"`]/gi;
  for (const m of code.matchAll(pattern)) {
    const ref = m[1];
    if (ref.length > 220 || ref.includes('..') || ref.startsWith('//')) continue;
    const resolved = resolveRelativeUrl(baseUrl, ref);
    if (!resolved) continue;
    if (/\.json$/i.test(ref)) jsonUrls.add(resolved);
    else if (/\.(png|webp|jpe?g|gif|svg)$/i.test(ref)) imageUrls.add(resolved);
  }

  return { imageUrls, jsonUrls };
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

function parseAtlasRegionsServer(atlasText: string): Array<{
  name: string;
  pageName: string;
  rotate: number;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const lines = atlasText.split(/\r?\n/);
  const regions: Array<{
    name: string;
    pageName: string;
    rotate: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  let currentPage: string | null = null;
  let currentRegion: {
    name: string;
    pageName: string;
    rotate: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  const parsePair = (val: string): [number, number] => {
    const parts = val.split(',').map((s) => Number(s.trim()));
    return [parts[0] || 0, parts[1] || 0];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentRegion) {
        regions.push(currentRegion);
        currentRegion = null;
      }
      currentPage = null;
      continue;
    }
    const isIndented = /^\s+/.test(rawLine);
    const colonIdx = trimmed.indexOf(':');
    if (!currentPage) {
      currentPage = trimmed;
      continue;
    }
    if (!isIndented && colonIdx === -1) {
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(trimmed)) {
        if (currentRegion) {
          regions.push(currentRegion);
          currentRegion = null;
        }
        currentPage = trimmed;
      } else {
        if (currentRegion) regions.push(currentRegion);
        currentRegion = {
          name: trimmed,
          pageName: currentPage,
          rotate: 0,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
      }
      continue;
    }
    if (currentRegion && colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'rotate') {
        currentRegion.rotate = val === 'true' ? 90 : val === 'false' ? 0 : Number(val) || 0;
      } else if (key === 'xy') {
        const [x, y] = parsePair(val);
        currentRegion.x = x;
        currentRegion.y = y;
      } else if (key === 'size') {
        const [w, h] = parsePair(val);
        currentRegion.width = w;
        currentRegion.height = h;
      }
    }
  }
  if (currentRegion) regions.push(currentRegion);
  return regions;
}

function cropImageBufferWithConvert(
  inputBuffer: Buffer,
  ext: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotateDeg: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputFmt = ext === 'png' ? 'png:-' : ext === 'jpg' || ext === 'jpeg' ? 'jpg:-' : 'webp:-';
    const args = [
      inputFmt,
      '-crop',
      `${Math.max(1, w)}x${Math.max(1, h)}+${Math.max(0, x)}+${Math.max(0, y)}`,
      '+repage',
    ];
    if (rotateDeg === 90) {
      args.push('-rotate', '-90');
    }
    args.push('-resize', '144x144>', 'png:-');

    const proc = spawn('convert', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(Buffer.concat(errChunks).toString('utf8') || `convert exited ${code}`));
      }
    });

    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

const thumbMemoryCache = new Map<string, Buffer>();

interface EnrichedCharacterMeta {
  name?: string;
  nameArtUrl?: string;
}

let cachedMetaPromise: Promise<Map<string, EnrichedCharacterMeta>> | null = null;
let cachedMetaTimestamp = 0;

const JOTA_DD = [
  0xeb, 0x14, 0x79, 0xb3, 0xa9, 0xd6, 0x0c, 0x6e, 0x2d, 0x7c, 0x0f, 0x45, 0xc3, 0x45, 0x8f, 0x0d,
  0xcc, 0x7f, 0x81, 0x52, 0xfa, 0xb1, 0x4b, 0xc1, 0x7c, 0x49, 0x5b, 0x52, 0x69, 0x3b, 0xfd, 0x96,
];
const JOTA_CD = [
  0x5c, 0x16, 0x0c, 0x5a, 0x22, 0x5e, 0xb5, 0xd2, 0xb4, 0xc6, 0xca, 0xef, 0xbe, 0xbf, 0xde, 0xc2,
  0x95, 0xc0, 0x60, 0xac, 0xf0, 0x7a, 0xd6, 0x64, 0x48, 0x23, 0xec, 0xa8, 0xdb, 0xa0, 0x14, 0xaf,
];

async function buildStaticCatalogMetaFallback(): Promise<Map<string, EnrichedCharacterMeta>> {
  const map = new Map<string, EnrichedCharacterMeta>();
  try {
    const raw = await fs.readFile(path.join(__dirname, 'public', 'data', 'naruto-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      ninjas?: Array<{ id: string; name?: string; nameArtUrl?: string }>;
    };
    for (const n of parsed.ninjas || []) {
      if (n.name || n.nameArtUrl) {
        map.set(n.id, { name: n.name, nameArtUrl: n.nameArtUrl });
      }
    }
  } catch {
    // ignore missing static catalog
  }
  return map;
}

interface JotaGameTables extends BackupTablesLike {
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

let cachedJotaTablesPromise: Promise<JotaGameTables | null> | null = null;
let cachedJotaTablesOrigin = '';
let cachedJotaTablesTs = 0;

function isAllowedJotaHost(origin: string): boolean {
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === 'jotagame.com' || h.endsWith('.jotagame.com');
  } catch {
    return false;
  }
}

async function loadJotaGameTables(
  activeOrigin: string,
  activeHtml?: string
): Promise<JotaGameTables | null> {
  if (!isAllowedJotaHost(activeOrigin)) {
    return null;
  }

  const now = Date.now();
  if (
    cachedJotaTablesPromise &&
    cachedJotaTablesOrigin === activeOrigin &&
    now - cachedJotaTablesTs < 30 * 60 * 1000
  ) {
    return cachedJotaTablesPromise;
  }

  cachedJotaTablesOrigin = activeOrigin;
  cachedJotaTablesTs = now;
  cachedJotaTablesPromise = (async () => {
    try {
      let html = activeHtml || '';
      if (!html) {
        const pageResp = await fetchWithTimeout(`${activeOrigin}/jogar?app=1`, 10000, 'text/html,*/*');
        if (!pageResp.ok) return null;
        html = await pageResp.text();
      }
      const recMatch = html.match(
        /window\.__VDF_RECURSOS__\s*=\s*\{[^}]*"manifesto"\s*:\s*"([^"]+)"/
      );
      const manifestoRel = recMatch?.[1];
      if (!manifestoRel) return null;

      const manifestoUrl = new URL(manifestoRel, activeOrigin).toString();
      const manResp = await fetchWithTimeout(manifestoUrl, 8000, 'application/json');
      if (!manResp.ok) return null;
      const man = (await manResp.json()) as {
        dadosVersao?: string;
        arquivos?: Record<string, { url: string; bytes?: number }>;
      };
      const fileSet = new Set<string>();
      const fileSizeByPath = new Map<string, number>();
      const fileByLower = new Map<string, string>();
      const heroVideoByLower = new Map<string, string>();
      const recruitVideoByLower = new Map<string, string>();
      const soundFileByLower = new Map<string, string>();
      for (const entry of Object.values(man.arquivos || {})) {
        const rel = entry?.url;
        if (!rel) continue;
        fileSet.add(rel);
        fileSizeByPath.set(rel, Number(entry.bytes || 0));
        fileByLower.set(rel.toLowerCase(), rel);
        if (rel.startsWith('acervo/video/hero/') && rel.endsWith('.mp4')) {
          const base = rel.slice('acervo/video/hero/'.length, -4).toLowerCase();
          heroVideoByLower.set(base, rel);
        } else if (rel.startsWith('acervo/video/recruit/') && rel.endsWith('.mp4')) {
          const base = rel.slice('acervo/video/recruit/'.length, -4).toLowerCase();
          recruitVideoByLower.set(base, rel);
        } else if (rel.startsWith('acervo/som/') && rel.endsWith('.mp3')) {
          soundFileByLower.set(rel.toLowerCase(), rel);
        }
      }
      const v = man.dadosVersao || '0';

      const master = Buffer.from(JOTA_DD.map((val, i) => val ^ JOTA_CD[i]));
      const nomeKey = crypto.createHmac('sha256', master).update('nome').digest();
      const dadosKey = crypto.createHmac('sha256', master).update('dados').digest();

      const fetchDados = async (pathStr: string): Promise<Record<string, unknown>> => {
        const slug = crypto
          .createHmac('sha256', nomeKey)
          .update(pathStr)
          .digest()
          .subarray(0, 16)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const resp = await fetchWithTimeout(`${activeOrigin}/d/${slug}?v=${v}`, 9000, '*/*');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const decipher = crypto.createDecipheriv('aes-256-gcm', dadosKey, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(buf.length - 16));
        const dec = Buffer.concat([
          decipher.update(buf.subarray(12, buf.length - 16)),
          decipher.final(),
        ]);
        return JSON.parse(zlib.gunzipSync(dec).toString('utf8')) as Record<string, unknown>;
      };

      const [herois, pt, roleModels, skins, skills, sons] = await Promise.all([
        fetchDados('dados/jogo/herois.json'),
        fetchDados('dados/jogo/pt.json'),
        fetchDados('dados/tabelas/json/RoleModel.json'),
        fetchDados('dados/tabelas/json/SkinConfig.json'),
        fetchDados('dados/jogo/skills.json').catch(() => ({})),
        fetchDados('dados/jogo/sons.json').catch(() => ({})),
      ]);

      return {
        origin: activeOrigin,
        fileSet,
        fileSizeByPath,
        fileByLower,
        heroVideoByLower,
        recruitVideoByLower,
        soundFileByLower,
        herois: herois as Record<string, Record<string, unknown>>,
        pt,
        roleModels: roleModels as Record<string, Record<string, unknown>>,
        skins: skins as Record<string, Record<string, unknown>>,
        skills: skills as Record<string, Record<string, unknown>>,
        sons: sons as Record<string, string>,
      };
    } catch {
      cachedJotaTablesPromise = null;
      return null;
    }
  })();

  return cachedJotaTablesPromise;
}

interface PassiveAuraServerDef {
  id: string;
  label: string;
  atlasUrl: string;
  skeletonUrl: string;
  layers: Array<{
    layer: 'behind' | 'front';
    introAnim?: string;
    loopAnim: string;
    outroAnim?: string;
  }>;
}

function resolvePassiveAuraServer(
  origin: string,
  ninjaId: string,
  heroCode: string,
  displayName?: string
): PassiveAuraServerDef | null {
  const idLower = ninjaId.toLowerCase();
  const codeStr = String(heroCode || '').trim();
  const code6 = codeStr.length === 8 && codeStr.startsWith('100') ? codeStr.slice(0, 6) : codeStr;
  const estadoBase = `${origin}/acervo/asset/spine-no-estados`;
  const spineBase = `${origin}/acervo/asset/spine`;

  if (idLower === 'vdfno_100637' || code6 === '100637') {
    return {
      id: 'noe_yuehziyan_daiji',
      label: 'Aura Passiva (Idle)',
      atlasUrl: `${spineBase}/noe_yuehziyan_daiji.atlas`,
      skeletonUrl: `${spineBase}/noe_yuehziyan_daiji.json`,
      layers: [
        { layer: 'behind', loopAnim: 'xia' },
        { layer: 'front', loopAnim: 'shang' },
      ],
    };
  }

  const armorByCode: Record<string, 'sasuke' | 'azul' | 'itachi' | 'shisui' | 'madara'> = {
    '100038': 'sasuke',
    '100306': 'sasuke',
    '100050': 'azul',
    '100365': 'azul',
    '100569': 'itachi',
    '100640': 'shisui',
    '100673': 'madara',
  };

  let preset = armorByCode[codeStr] || armorByCode[code6];
  if (!preset && (idLower === 'zuozhuxiao' || idLower === 'vdfno_100306')) {
    preset = 'sasuke';
  }
  if (!preset && idLower === 'renzhankakaxi') {
    preset = 'azul';
  }
  if (!preset && displayName && /susano/i.test(displayName) && idLower !== 'dyyjiaodu') {
    preset = 'sasuke';
  }
  if (!preset) return null;

  if (preset === 'sasuke') {
    return {
      id: 'noe_ZUOZHUXZbati',
      label: "Armadura: Susano'o",
      atlasUrl: `${estadoBase}/noe_ZUOZHUXZbati.atlas`,
      skeletonUrl: `${estadoBase}/noe_ZUOZHUXZbati.json`,
      layers: [{ layer: 'front', introAnim: 'b1', loopAnim: 'b2', outroAnim: 'b3' }],
    };
  }
  if (preset === 'itachi') {
    return {
      id: 'noe_Youzhongguofeng_beidong',
      label: "Armadura: Susano'o (Itachi)",
      atlasUrl: `${estadoBase}/noe_Youzhongguofeng_beidong.atlas`,
      skeletonUrl: `${estadoBase}/noe_Youzhongguofeng_beidong.json`,
      layers: [{ layer: 'front', introAnim: 'b1', loopAnim: 'b2', outroAnim: 'b3' }],
    };
  }
  if (preset === 'shisui') {
    return {
      id: 'noe_Yuzhibozhishuizhongguofeng_beidong',
      label: "Armadura: Susano'o (Shisui)",
      atlasUrl: `${estadoBase}/noe_Yuzhibozhishuizhongguofeng_beidong.atlas`,
      skeletonUrl: `${estadoBase}/noe_Yuzhibozhishuizhongguofeng_beidong.json`,
      layers: [
        { layer: 'behind', introAnim: 'b1xia', loopAnim: 'b2xia', outroAnim: 'b3xia' },
        { layer: 'front', introAnim: 'b1shang', loopAnim: 'b2shang', outroAnim: 'b3shang' },
      ],
    };
  }
  if (preset === 'azul') {
    return {
      id: 'noe_Banzhongyanzhizhan_bati',
      label: "Armadura: Susano'o Azul",
      atlasUrl: `${estadoBase}/noe_Banzhongyanzhizhan_bati.atlas`,
      skeletonUrl: `${estadoBase}/noe_Banzhongyanzhizhan_bati.json`,
      layers: [{ layer: 'front', loopAnim: 'shang' }],
    };
  }
  return {
    id: 'noe_xuzuobanbati',
    label: "Armadura: Susano'o (Madara)",
    atlasUrl: `${estadoBase}/noe_xuzuobanbati.atlas`,
    skeletonUrl: `${estadoBase}/noe_xuzuobanbati.json`,
    layers: [
      {
        layer: 'front',
        introAnim: 'xuzuobanbati_kaiqi',
        loopAnim: 'xuzuobanbati_chixu',
        outroAnim: 'xuzuobanbati_jiesu',
      },
    ],
  };
}

function resolveSoundUrlFromTables(
  origin: string,
  soundKey: string,
  sons: Record<string, string>,
  fileSet?: Set<string>,
  soundFileByLower?: Map<string, string>
): string | null {
  const clean = soundKey.trim();
  if (!clean) return null;
  const mapped = sons[clean];
  if (typeof mapped === 'string' && mapped) {
    const rel = mapped.replace(/^\/+/, '');
    return `${origin}/${rel}`;
  }
  const candidates: string[] = [];
  if (clean.startsWith('nos_')) {
    candidates.push(`acervo/som/nos/${clean.slice(4)}.mp3`);
  }
  if (clean.toLowerCase().startsWith('die_')) {
    candidates.push(`acervo/som/Die/${clean}.mp3`);
  }
  candidates.push(
    `acervo/som/${clean}.mp3`,
    `acervo/som/lines/${clean}.mp3`,
    `acervo/som/AFaoyi/${clean}.mp3`
  );
  if (fileSet && fileSet.size > 0) {
    for (const c of candidates) {
      if (fileSet.has(c)) return `${origin}/${c}`;
      const lowerMatch = soundFileByLower?.get(c.toLowerCase());
      if (lowerMatch) return `${origin}/${lowerMatch}`;
    }
  }
  return `${origin}/${candidates[0]}`;
}

const KNOWN_VDFNO_VIDEOS: Record<string, string[]> = {
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

const SPECIAL_HERO_VIDEO_ALIASES: Record<string, string[]> = {
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

function resolveHeroVideoUrlFromTables(
  origin: string,
  source: string,
  tables?: Pick<JotaGameTables, 'fileSet' | 'heroVideoByLower' | 'recruitVideoByLower'> | null,
  kind: 'ultimate' | 'recruit' = 'ultimate'
): string | null {
  const clean = source.trim().replace(/\.mp4$/i, '');
  if (!clean) return null;
  const low = clean.toLowerCase();

  if (tables && tables.fileSet.size > 0) {
    const heroLookup = (k: string) => tables.heroVideoByLower.get(k);
    const recruitLookup = (k: string) => tables.recruitVideoByLower.get(k);
    const hit =
      kind === 'recruit'
        ? recruitLookup(low) || heroLookup(low)
        : heroLookup(low) ||
          heroLookup(`${low}_left`) ||
          heroLookup(`${low}_right`) ||
          recruitLookup(low);
    return hit ? `${origin}/${hit}` : null;
  }

  return kind === 'recruit'
    ? `${origin}/acervo/video/recruit/${clean}.mp4`
    : `${origin}/acervo/video/hero/${clean}.mp4`;
}

function stripSkinSuffix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(
      /(?:vippifu|ptpifu|chaopifu|pifu|maozi|xinchun|yongzhuang|yonghzuang|tangzhuangb|tangzhuang|mianju)$/i,
      ''
    );
}

function resolveAllHeroVideosServer(
  tables: JotaGameTables,
  opts: {
    ninjaId: string;
    code?: string;
    rmObj?: Record<string, unknown>;
    baseRmObj?: Record<string, unknown>;
    heroObj?: Record<string, unknown>;
    baseHeroObj?: Record<string, unknown>;
    requestedVideos?: string[];
    requestedFeatures?: string[];
  }
): {
  videos: Array<{ key: string; label: string; kind: 'ultimate' | 'recruit'; url: string }>;
  videoUrlMap: Record<string, string>;
} {
  const { origin, heroVideoByLower, recruitVideoByLower } = tables;
  const videos: Array<{ key: string; label: string; kind: 'ultimate' | 'recruit'; url: string }> =
    [];
  const videoUrlMap: Record<string, string> = {};
  const seenUrls = new Set<string>();

  const pushVideo = (
    key: string,
    relPath: string,
    kind: 'ultimate' | 'recruit',
    label?: string
  ) => {
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

  // 1. Explicit {PLAYVEDIO} sources from Spine skeleton
  for (const vidSource of opts.requestedVideos || []) {
    const clean = vidSource.trim().replace(/\.mp4$/i, '');
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

  // 2. Known vdfno_* ultimate MP4s & tag/alias/skin-base ultimate MP4s
  const idLow = opts.ninjaId.toLowerCase();
  const vdfKeys = KNOWN_VDFNO_VIDEOS[idLow];
  if (vdfKeys) {
    for (const k of vdfKeys) {
      const rel = heroVideoByLower.get(k.toLowerCase());
      if (rel) pushVideo(k, rel, 'ultimate');
    }
  }

  const candidateTags = new Set<string>();
  const addTag = (val: unknown) => {
    if (typeof val !== 'string') return;
    const t = val.trim();
    if (!t || t.toLowerCase().startsWith('vdfno_')) return;
    const tl = t.toLowerCase();
    candidateTags.add(tl);
    const stripped = stripSkinSuffix(tl);
    if (stripped && stripped.length >= 3) candidateTags.add(stripped);
  };

  if (!idLow.startsWith('vdfno_')) {
    addTag(opts.ninjaId);
    addTag(opts.rmObj?.Tag);
    addTag(opts.rmObj?.Animation);
    addTag(opts.baseRmObj?.Tag);
    addTag(opts.baseRmObj?.Animation);
    const modelo = opts.heroObj?.modelo as Record<string, unknown> | undefined;
    const baseModelo = opts.baseHeroObj?.modelo as Record<string, unknown> | undefined;
    addTag(modelo?.spine);
    addTag(modelo?.tag);
    addTag(baseModelo?.spine);
    addTag(baseModelo?.tag);
  }
  const modelo = opts.heroObj?.modelo as Record<string, unknown> | undefined;
  const baseModelo = opts.baseHeroObj?.modelo as Record<string, unknown> | undefined;

  // Extract stems from {SHOWFEATURE} file names (e.g. "feiduantexie1" -> "feiduan", "gangshoupifutexie" -> "gangshou")
  for (const feat of opts.requestedFeatures || []) {
    const fl = feat.trim().toLowerCase();
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

  // 3. Recruit / presentation HeroVideo from RoleModel or base RoleModel or herois.modelo.video
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

async function fetchJotaCharacterMetaMap(
  activeOrigin: string,
  activeHtml: string,
  ninjas: Array<{ id: string; code: string }>
): Promise<Map<string, EnrichedCharacterMeta>> {
  if (!isAllowedJotaHost(activeOrigin)) {
    return new Map();
  }

  const now = Date.now();
  if (cachedMetaPromise && now - cachedMetaTimestamp < 30 * 60 * 1000) {
    return cachedMetaPromise;
  }

  cachedMetaTimestamp = now;
  cachedMetaPromise = (async () => {
    const fallbackMap = await buildStaticCatalogMetaFallback();
    try {
      const tables = await loadJotaGameTables(activeOrigin, activeHtml);
      if (!tables) return fallbackMap;
      const { fileSet, herois, pt, roleModels, skins } = tables;

      const resolvePt = (link: unknown): string | undefined => {
        if (!link) return undefined;
        const key = String(link).replace(/^Translate\.Id:/, '');
        const val = pt[key];
        if (!val) return undefined;
        const resolved = Array.isArray(val) ? String(val[0] || '') : String(val);
        return resolved.trim() || undefined;
      };

      type RoleModelObj = Record<string, unknown>;
      const byTag = new Map<string, RoleModelObj>();
      for (const rmVal of Object.values(roleModels)) {
        if (!rmVal || typeof rmVal !== 'object') continue;
        const rm = rmVal as RoleModelObj;
        for (const k of [rm.Tag, rm.Animation, rm.SpineAnim]) {
          if (typeof k === 'string' && k) {
            const kl = k.toLowerCase();
            if (!byTag.has(kl)) byTag.set(kl, rm);
          }
        }
      }

      const skinByModel = new Map<string, RoleModelObj>();
      for (const skVal of Object.values(skins)) {
        if (!skVal || typeof skVal !== 'object') continue;
        const sk = skVal as RoleModelObj;
        if (sk.roleModel != null) {
          skinByModel.set(String(sk.roleModel), sk);
        }
      }

      const pickExistingAsset = (candidates: Array<unknown>): string | undefined => {
        for (const rel of candidates) {
          if (typeof rel !== 'string' || !rel) continue;
          const clean = rel.replace(/^\/+/, '');
          const ptBase = clean.startsWith('acervo/') ? clean : `acervo/language/pt/${clean}`;
          const ptWebp = ptBase.replace(/\.png$/i, '.webp');
          if (fileSet.has(ptWebp)) return `${activeOrigin}/${ptWebp}`;
          if (fileSet.has(ptBase)) return `${activeOrigin}/${ptBase}`;
        }
        return undefined;
      };

      const map = new Map<string, EnrichedCharacterMeta>(fallbackMap);
      for (const n of ninjas) {
        const idLow = n.id.toLowerCase();
        const code6 = n.code.length === 8 && n.code.startsWith('100') ? n.code.slice(0, 6) : n.code;
        const rm =
          byTag.get(idLow) ||
          (roleModels[n.code] as RoleModelObj | undefined) ||
          (roleModels[code6] as RoleModelObj | undefined);
        const modelCode = rm?.model != null ? String(rm.model) : code6;

        let name =
          (rm && resolvePt(rm.__link_name)) ||
          (rm?.model != null
            ? resolvePt((roleModels[String(rm.model)] as RoleModelObj | undefined)?.__link_name) ||
              resolvePt(`HeroBase_${rm.model}_name`)
            : undefined) ||
          resolvePt((herois[n.code] as RoleModelObj | undefined)?.__link_name) ||
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

        if (name || nameArtUrl) {
          map.set(n.id, {
            name: name || fallbackMap.get(n.id)?.name,
            nameArtUrl: nameArtUrl || fallbackMap.get(n.id)?.nameArtUrl,
          });
        }
      }

      return map;
    } catch {
      return fallbackMap;
    }
  })();

  return cachedMetaPromise;
}

function buildNinjaMediaProfileFromTables(
  tables: JotaGameTables,
  params: {
    ninjaId: string;
    code?: string;
    displayName?: string;
    requestedSounds?: string[];
    requestedVideos?: string[];
    requestedFeatures?: string[];
  }
): Record<string, unknown> {
  const { origin, herois, pt, roleModels, skills, sons, fileSet, fileByLower, soundFileByLower } = tables;
  const ninjaId = params.ninjaId;
  const code = params.code || '';
  const idLow = ninjaId.toLowerCase();
  const code6 = code.length === 8 && code.startsWith('100') ? code.slice(0, 6) : code;

  let heroObj: Record<string, unknown> | undefined;
  let baseHeroObj: Record<string, unknown> | undefined;
  let rmObj: Record<string, unknown> | undefined;
  let baseRmObj: Record<string, unknown> | undefined;
  let resolvedHeroCode = code6 || code;
  let resolvedName = params.displayName || undefined;

  const skillsOut: Record<
    string,
    {
      id: string;
      animKey: string;
      slotLabel: string;
      name: string;
      desc?: string;
      iconName?: string;
      iconUrl?: string;
    }
  > = {};
  const passivesOut: Array<{
    id: string;
    name: string;
    desc?: string;
    iconName?: string;
    iconUrl?: string;
  }> = [];
  const voicesOut: Array<{ key: string; category: string; label: string; url: string }> = [];
  const soundUrlMap: Record<string, string> = {};

  const resolveSkillIconUrl = (
    iconVal: unknown
  ): { iconName?: string; iconUrl?: string } => {
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
      if (fileSet.has(c)) {
        return { iconName, iconUrl: `${origin}/${c}` };
      }
      const lowerMatch = fileByLower.get(c.toLowerCase());
      if (lowerMatch) {
        return { iconName, iconUrl: `${origin}/${lowerMatch}` };
      }
    }
    return { iconName };
  };

  const resolvePt = (val: unknown): string | undefined => {
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

  for (const rm of Object.values(roleModels)) {
    if (!rm || typeof rm !== 'object') continue;
    const tag = String(rm.Tag || '').toLowerCase();
    const anim = String(rm.Animation || '').toLowerCase();
    if (tag === idLow || anim === idLow) {
      rmObj = rm;
      break;
    }
  }
  if (!rmObj) {
    rmObj = roleModels[code] || roleModels[code6];
  }
  if (rmObj?.model != null) {
    const baseKey = String(rmObj.model);
    baseRmObj = roleModels[baseKey];
    baseHeroObj = herois[baseKey];
  }

  if (rmObj) {
    heroObj = (rmObj.Id != null ? herois[String(rmObj.Id)] : undefined) || baseHeroObj;
  }
  if (!heroObj) {
    for (const h of Object.values(herois)) {
      const modelo = h?.modelo as Record<string, unknown> | undefined;
      if (
        modelo &&
        (String(modelo.spine || '').toLowerCase() === idLow ||
          String(modelo.tag || '').toLowerCase() === idLow)
      ) {
        heroObj = h;
        break;
      }
    }
  }
  if (!heroObj) {
    heroObj = herois[code] || herois[code6] || baseHeroObj;
  }

  if (heroObj?.Id != null) {
    resolvedHeroCode = String(heroObj.Id);
  } else if (rmObj?.Id != null) {
    resolvedHeroCode = String(rmObj.Id);
  }

  if (typeof heroObj?.name === 'string' && heroObj.name.trim()) {
    resolvedName = heroObj.name.trim();
  } else if (rmObj?.__link_name) {
    resolvedName = resolvePt(rmObj.__link_name) || resolvedName;
  }

  const addSkill = (animKey: string, slotLabel: string, skillId: unknown) => {
    if (typeof skillId !== 'string' || !skillId.trim()) return;
    const sk = skills[skillId.trim()];
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
  };

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
      const sk = skills[pId.trim()];
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
    }
  }

  const seenVoiceKeys = new Set<string>();
  const pushVoice = (category: string, label: string, keyVal: unknown) => {
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
      soundUrlMap[cleanKey] = url;
      const dedupeKey = `${category}::${cleanKey}`;
      if (seenVoiceKeys.has(dedupeKey)) continue;
      seenVoiceKeys.add(dedupeKey);
      voicesOut.push({ key: cleanKey, category, label, url });
    }
  };

  const modelo = (heroObj?.modelo as Record<string, unknown> | undefined) || undefined;
  const vozesRoot = (modelo?.vozes as Record<string, unknown> | undefined) || undefined;
  const vdfVozes =
    (vozesRoot?.[resolvedHeroCode] as Record<string, unknown> | undefined) ||
    (vozesRoot?.[code6] as Record<string, unknown> | undefined) ||
    (vozesRoot ? (Object.values(vozesRoot)[0] as Record<string, unknown> | undefined) : undefined) ||
    (rmObj?.VdfVozes as Record<string, unknown> | undefined);

  if (vdfVozes && typeof vdfVozes === 'object') {
    pushVoice('batalha', 'Voz de Batalha', vdfVozes.batalha);
    pushVoice('transformacao', 'Transformação / Especial', vdfVozes.transformacao);
    pushVoice('despertar', 'Despertar', vdfVozes.despertar);
    pushVoice('subir_estrela', 'Subir Estrela', vdfVozes.subir_estrela);
  }

  const modeloAudio = (modelo?.audio as Record<string, unknown> | undefined) || undefined;
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

  const allSoundKeys = new Set<string>(params.requestedSounds || []);
  if (Array.isArray(modelo?.sons)) {
    for (const s of modelo.sons) if (typeof s === 'string' && s.trim()) allSoundKeys.add(s.trim());
  }
  for (const rmCandidate of [rmObj, baseRmObj]) {
    if (Array.isArray(rmCandidate?.SoundEffect)) {
      for (const s of rmCandidate.SoundEffect) {
        if (typeof s === 'string' && s.trim()) allSoundKeys.add(s.trim());
      }
    }
  }
  for (const sKey of allSoundKeys) {
    if (soundUrlMap[sKey]) continue;
    const url = resolveSoundUrlFromTables(origin, sKey, sons, fileSet, soundFileByLower);
    if (url) soundUrlMap[sKey] = url;
  }

  const resolvedVids = resolveAllHeroVideosServer(tables, {
    ninjaId,
    code,
    rmObj,
    baseRmObj,
    heroObj,
    baseHeroObj,
    requestedVideos: params.requestedVideos,
    requestedFeatures: params.requestedFeatures,
  });

  const passiveAura = resolvePassiveAuraServer(origin, ninjaId, resolvedHeroCode, resolvedName);

  return {
    ninjaId,
    heroCode: resolvedHeroCode || undefined,
    displayName: resolvedName,
    skills: skillsOut,
    passives: passivesOut,
    passiveAura,
    videos: resolvedVids.videos,
    voices: voicesOut,
    soundUrlMap,
    videoUrlMap: resolvedVids.videoUrlMap,
    originBase: origin,
  };
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const catalogCache = new Map<string, { ts: number; data: BackupExtractPayload }>();

  async function extractCatalogForUrl(rawUrl: string): Promise<BackupExtractPayload> {
    const startedAt = Date.now();
    const initialUrl = await validatePublicUrl(rawUrl);
    const cacheKey = initialUrl.toString();
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 15 * 60 * 1000) {
      return cached.data;
    }

    const initialResp = await fetchWithTimeout(initialUrl.toString(), 12000, 'text/html,*/*');
    if (!initialResp.ok) {
      throw new Error(`Falha ao acessar a URL (HTTP ${initialResp.status}).`);
    }

      const initialHtml = await initialResp.text();
      let activeUrl = initialResp.url || initialUrl.toString();
      let activeHtml = initialHtml;

      // Check if this page is a thin launcher/redirect page (like naruto.jotagame.com/ -> jogar?app=1)
      const entrypoints = detectGameEntrypoints(initialHtml, activeUrl);
      const sameOriginEntry = entrypoints.find((ep) => {
        try {
          return new URL(ep).origin === new URL(activeUrl).origin && ep !== activeUrl;
        } catch {
          return false;
        }
      });

      if (sameOriginEntry) {
        try {
          await validatePublicUrl(sameOriginEntry);
          const gameResp = await fetchWithTimeout(sameOriginEntry, 12000, 'text/html,*/*');
          if (gameResp.ok) {
            const gameHtml = await gameResp.text();
            if (gameHtml.length > activeHtml.length) {
              activeUrl = gameResp.url || sameOriginEntry;
              activeHtml = gameHtml;
            }
          }
        } catch {
          // keep initial HTML if secondary entrypoint fails
        }
      }

      const activeOrigin = new URL(activeUrl).origin;
      const gameTitle = extractTitle(activeHtml);
      const { scriptUrls, cssUrls, imageUrls, jsonUrls } = extractReferencesFromHtml(activeHtml, activeUrl);

      // Probe same-origin scripts (prefer entry script first, up to 14 scripts)
      const sameOriginScripts = Array.from(scriptUrls)
        .filter((u) => {
          try {
            return new URL(u).origin === activeOrigin;
          } catch {
            return false;
          }
        })
        .slice(0, 28);

      const sameOriginCss = Array.from(cssUrls)
        .filter((u) => {
          try {
            return new URL(u).origin === activeOrigin;
          } catch {
            return false;
          }
        })
        .slice(0, 6);

      let scannedScripts = 0;
      const codeFetchQueue = [...sameOriginScripts, ...sameOriginCss];

      // Fetch scripts in batches of 6
      for (let i = 0; i < codeFetchQueue.length; i += 6) {
        const batch = codeFetchQueue.slice(i, i + 6);
        await Promise.all(
          batch.map(async (fileUrl) => {
            try {
              const r = await fetchWithTimeout(fileUrl, 8000, 'text/javascript,text/css,*/*');
              if (!r.ok) return;
              const text = await r.text();
              if (text.length > 4 * 1024 * 1024) return;
              scannedScripts++;
              const extracted = extractPathsFromCode(text, activeUrl);
              extracted.imageUrls.forEach((u) => imageUrls.add(u));
              extracted.jsonUrls.forEach((u) => jsonUrls.add(u));
            } catch {
              // ignore individual script timeouts
            }
          })
        );
      }

      // Check well-known / discovered Spine & spritesheet index JSONs
      const ninjas: Array<{
        id: string;
        code: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        atlasUrl: string;
        skeletonUrl: string;
        kind: 'character' | 'summon_skin' | 'effect';
        sourceIndex: 'spine-hd' | 'spine-astc' | 'code';
      }> = [];

      const sheets: Array<{
        name: string;
        url: string;
        width?: number;
        height?: number;
        bytes?: number;
        sheetKind: 'astc_sheet' | 'spine_sheet';
      }> = [];

      // Look for spine index JSONs (e.g. acervo/asset/spine-hd/indice.json) and spritesheet list JSONs
      const candidateJsonUrls = Array.from(jsonUrls).filter((u) => {
        const lower = u.toLowerCase();
        return (
          lower.includes('indice.json') ||
          lower.includes('lista.json') ||
          lower.includes('atlas') ||
          lower.includes('manifest') ||
          lower.includes('sprite')
        );
      });

      const spineBaseCandidates = new Set<string>();
      for (const jUrl of candidateJsonUrls) {
        if (jUrl.includes('/spine-hd/indice.json')) {
          spineBaseCandidates.add(jUrl.replace(/\/spine-hd\/indice\.json.*$/, '/spine'));
        }
        if (jUrl.includes('/spine-astc/lista.json')) {
          spineBaseCandidates.add(jUrl.replace(/\/spine-astc\/lista\.json.*$/, '/spine'));
        }
      }
      const defaultSpineBase =
        Array.from(spineBaseCandidates)[0] || resolveRelativeUrl(activeUrl, 'acervo/asset/spine') || `${activeOrigin}/acervo/asset/spine`;

      await Promise.all(
        candidateJsonUrls.slice(0, 8).map(async (jUrl) => {
          try {
            await validatePublicUrl(jUrl);
            const resp = await fetchWithTimeout(jUrl, 9000, 'application/json');
            if (!resp.ok) return;
            const data = (await resp.json()) as Record<string, unknown>;
            if (!data || typeof data !== 'object' || Array.isArray(data)) return;

            for (const [key, val] of Object.entries(data)) {
              if (!val || typeof val !== 'object') continue;
              const obj = val as Record<string, unknown>;

              // Spine character bounds index (e.g. "vdfno_100301": { x, y, w, h })
              if (
                typeof obj.w === 'number' &&
                typeof obj.h === 'number' &&
                typeof obj.bytes !== 'number' &&
                !key.includes('.')
              ) {
                const codeMatch = key.match(/(\d+)$/);
                ninjas.push({
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

              // Spritesheet list index (e.g. "no_11000131.webp": { w, h, bytes } or "Wanshe.webp": { w, h, bytes })
              if (
                /\.(webp|png|jpe?g)$/i.test(key) &&
                typeof obj.w === 'number' &&
                typeof obj.h === 'number'
              ) {
                const isNoSheet = key.toLowerCase().startsWith('no_');
                sheets.push({
                  name: key,
                  url: `${defaultSpineBase}/${key}`,
                  width: obj.w,
                  height: obj.h,
                  bytes: typeof obj.bytes === 'number' ? obj.bytes : undefined,
                  sheetKind: isNoSheet ? 'astc_sheet' : 'spine_sheet',
                });

                // Non-`no_*` entries in lista.json (186 summons, skins & effects) are complete Spine packages in /spine/
                if (!isNoSheet && !key.toLowerCase().startsWith('vdfno_')) {
                  const baseId = key.replace(/\.(webp|png|jpe?g)$/i, '');
                  const codeMatch = baseId.match(/(\d+)$/);
                  ninjas.push({
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
          } catch {
            // ignore non-matching JSON files
          }
        })
      );

      // Deduplicate keeping spine-hd metadata priority over spine-astc
      const ninjaMap = new Map<string, (typeof ninjas)[number]>();
      for (const n of ninjas) {
        const prev = ninjaMap.get(n.id);
        if (!prev || (prev.sourceIndex !== 'spine-hd' && n.sourceIndex === 'spine-hd')) {
          ninjaMap.set(n.id, n);
        }
      }

      // Check direct /spine/<name>.png|webp references discovered in scripts (e.g., huomiao.png)
      const directSpineCandidates = Array.from(imageUrls).filter((u) => {
        const lower = u.toLowerCase();
        if (!lower.includes('/spine/')) return false;
        const file = lower.split('?')[0].split('/').pop() || '';
        const base = file.replace(/\.(png|webp|jpe?g)$/i, '');
        return Boolean(base) && !base.startsWith('no_') && !ninjaMap.has(base);
      });

      await Promise.all(
        directSpineCandidates.slice(0, 12).map(async (imgUrl) => {
          try {
            const clean = imgUrl.split('?')[0];
            const file = clean.split('/').pop() || '';
            const baseId = file.replace(/\.(png|webp|jpe?g)$/i, '');
            const atlasCandidate = clean.replace(/\.(png|webp|jpe?g)$/i, '.atlas');
            const skelCandidate = clean.replace(/\.(png|webp|jpe?g)$/i, '.json');
            const headResp = await fetchWithTimeout(atlasCandidate, 4000, 'text/plain,*/*');
            if (!headResp.ok) return;
            const headText = await headResp.text();
            if (!headText || headText.trimStart().startsWith('<')) return;
            const codeMatch = baseId.match(/(\d+)$/);
            ninjaMap.set(baseId, {
              id: baseId,
              code: codeMatch ? codeMatch[1] : baseId,
              width: 256,
              height: 256,
              offsetX: 0,
              offsetY: 0,
              atlasUrl: atlasCandidate,
              skeletonUrl: skelCandidate,
              kind: classifySpinePackageKind(baseId),
              sourceIndex: 'code',
            });
          } catch {
            // ignore non-Spine loose images
          }
        })
      );

      // Also merge playable classic heroes from JotaGame tables (herois.json + RoleModel.json)
      // whose Spine .atlas + .json live directly in /acervo/asset/spine/ (not listed in spine-hd / spine-astc)
      const jotaTables = await loadJotaGameTables(activeOrigin, activeHtml);
      const existingLowerIds = new Set(Array.from(ninjaMap.keys()).map((k) => k.toLowerCase()));
      if (jotaTables) {
        const { fileSet, herois, roleModels } = jotaTables;
        const maybeAddPlayableSpine = (
          spineId: string,
          codeVal: string,
          w: number,
          h: number
        ) => {
          const cleanId = spineId.trim();
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

        for (const [heroCode, hObj] of Object.entries(herois)) {
          if (!hObj || typeof hObj !== 'object') continue;
          const modelo = hObj.modelo as Record<string, unknown> | undefined;
          const sp = typeof modelo?.spine === 'string' ? modelo.spine : '';
          if (!sp) continue;
          maybeAddPlayableSpine(
            sp,
            heroCode,
            Number(modelo?.largura) || 180,
            Number(modelo?.altura) || 180
          );
        }

        for (const [rmCode, rmObj] of Object.entries(roleModels)) {
          if (!rmObj || typeof rmObj !== 'object') continue;
          const sp =
            (typeof rmObj.Animation === 'string' && rmObj.Animation) ||
            (typeof rmObj.Tag === 'string' && rmObj.Tag) ||
            '';
          if (!sp) continue;
          // Only add playable hero IDs (100xxx range) or entries with HeroVideo so monsters/props aren't mixed in
          const numId = Number(rmObj.Id ?? rmCode);
          if (
            (Number.isFinite(numId) && numId >= 100000 && numId < 200000) ||
            Boolean(rmObj.HeroVideo)
          ) {
            maybeAddPlayableSpine(
              sp,
              String(rmObj.Id ?? rmCode),
              Number(rmObj.Width) || 180,
              Number(rmObj.Height) || 180
            );
          }
        }
      }

      const uniqueNinjasRaw = Array.from(ninjaMap.values()).sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      );

      // Build fast RoleModel lookup by Tag/Animation for hasVideo tagging
      const rmByTagLower = new Map<string, Record<string, unknown>>();
      if (jotaTables) {
        for (const rmVal of Object.values(jotaTables.roleModels)) {
          if (!rmVal || typeof rmVal !== 'object') continue;
          for (const k of [rmVal.Tag, rmVal.Animation]) {
            if (typeof k === 'string' && k && !rmByTagLower.has(k.toLowerCase())) {
              rmByTagLower.set(k.toLowerCase(), rmVal);
            }
          }
        }
      }

      const metaMap = await fetchJotaCharacterMetaMap(activeOrigin, activeHtml, uniqueNinjasRaw);
      const uniqueNinjas = uniqueNinjasRaw.map((n) => {
        const meta = metaMap.get(n.id);
        let hasVideo = false;
        if (jotaTables && n.kind !== 'effect') {
          const idLow = n.id.toLowerCase();
          const code6 =
            n.code.length === 8 && n.code.startsWith('100') ? n.code.slice(0, 6) : n.code;
          const rmObj =
            rmByTagLower.get(idLow) ||
            jotaTables.roleModels[n.code] ||
            jotaTables.roleModels[code6];
          const baseModelKey = rmObj?.model != null ? String(rmObj.model) : undefined;
          const baseRmObj = baseModelKey ? jotaTables.roleModels[baseModelKey] : undefined;
          const heroObj =
            jotaTables.herois[n.code] ||
            jotaTables.herois[code6] ||
            (baseModelKey ? jotaTables.herois[baseModelKey] : undefined);
          const baseHeroObj = baseModelKey ? jotaTables.herois[baseModelKey] : undefined;
          const resolved = resolveAllHeroVideosServer(jotaTables, {
            ninjaId: n.id,
            code: n.code,
            rmObj,
            baseRmObj,
            heroObj,
            baseHeroObj,
          });
          hasVideo = resolved.videos.length > 0;
        }
        return {
          ...n,
          ...(meta?.name ? { name: meta.name } : {}),
          ...(meta?.nameArtUrl ? { nameArtUrl: meta.nameArtUrl } : {}),
          ...(hasVideo ? { hasVideo: true } : {}),
        };
      });

      const uniqueSheets = Array.from(new Map(sheets.map((s) => [s.url, s])).values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );

      const assets = Array.from(imageUrls)
        .filter((u) => !u.includes('facebook.com'))
        .map((u) => {
          const cleanPath = u.split('?')[0];
          const name = cleanPath.split('/').pop() || cleanPath;
          const extMatch = cleanPath.match(/\.([a-z0-9]+)$/i);
          return {
            name,
            url: u,
            category: categorizeAsset(u),
            ext: extMatch ? extMatch[1].toLowerCase() : 'img',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const payload: BackupExtractPayload = {
        sourceUrl: initialUrl.toString(),
        resolvedGameUrl: activeUrl,
        gameTitle,
        ninjas: uniqueNinjas,
        sheets: uniqueSheets,
        assets,
        stats: {
          scannedScripts,
          discoveredAssets: assets.length,
          totalNinjas: uniqueNinjas.length,
          totalSheets: uniqueSheets.length,
          elapsedMs: Date.now() - startedAt,
        },
      };
      catalogCache.set(cacheKey, { ts: Date.now(), data: payload });
      return payload;
  }

  app.post('/api/extract', async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      if (!rawUrl.trim()) {
        res.status(400).json({ error: 'Informe a URL do jogo para extrair os sprites.' });
        return;
      }
      const payload = await extractCatalogForUrl(rawUrl);
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado ao extrair sprites.';
      const status = message.startsWith('Falha ao acessar a URL') ? 502 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/ninja-bundle', async (req, res) => {
    try {
      const atlasUrl = typeof req.query.atlasUrl === 'string' ? req.query.atlasUrl : '';
      const skeletonUrl = typeof req.query.skeletonUrl === 'string' ? req.query.skeletonUrl : '';

      if (!atlasUrl) {
        res.status(400).json({ error: 'Parâmetro atlasUrl obrigatório.' });
        return;
      }

      const validAtlasUrl = await validatePublicUrl(atlasUrl);
      const validSkeletonUrl = skeletonUrl ? await validatePublicUrl(skeletonUrl) : null;

      const [atlasResp, skelResp] = await Promise.all([
        fetchWithTimeout(validAtlasUrl.toString(), 10000, 'text/plain,*/*'),
        validSkeletonUrl
          ? fetchWithTimeout(validSkeletonUrl.toString(), 10000, 'application/json,*/*').catch(() => null)
          : Promise.resolve(null),
      ]);

      if (!atlasResp.ok) {
        res.status(502).json({ error: `Não foi possível baixar o arquivo .atlas (HTTP ${atlasResp.status}).` });
        return;
      }

      const atlasText = await atlasResp.text();
      if (atlasText.trimStart().startsWith('<')) {
        res.status(404).json({ error: 'Arquivo .atlas não encontrado neste endereço.' });
        return;
      }

      let skeleton: unknown = null;
      if (skelResp && skelResp.ok) {
        try {
          skeleton = await skelResp.json();
        } catch {
          skeleton = null;
        }
      }

      const pageFilenames = parseAtlasPageFilenames(atlasText);
      const pageUrls: Record<string, string> = {};
      for (const pageFile of pageFilenames) {
        const resolved = resolveRelativeUrl(validAtlasUrl.toString(), pageFile);
        if (resolved) {
          pageUrls[pageFile] = `/api/proxy?url=${encodeURIComponent(resolved)}`;
        }
      }

      res.json({
        atlasText,
        skeleton,
        pageUrls,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar pacote do ninja.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/ninja-media', async (req, res) => {
    try {
      const ninjaId = typeof req.query.id === 'string' ? req.query.id.trim().slice(0, 120) : '';
      const code = typeof req.query.code === 'string' ? req.query.code.trim().slice(0, 64) : '';
      const atlasUrl = typeof req.query.atlasUrl === 'string' ? req.query.atlasUrl.trim() : '';
      const displayNameParam =
        typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 120) : '';
      const soundsParam = typeof req.query.sounds === 'string' ? req.query.sounds.slice(0, 4000) : '';
      const videosParam = typeof req.query.videos === 'string' ? req.query.videos.slice(0, 1500) : '';
      const featuresParam =
        typeof req.query.features === 'string' ? req.query.features.slice(0, 1500) : '';

      if (!ninjaId || !atlasUrl) {
        res.status(400).json({ error: 'Parâmetros id e atlasUrl obrigatórios.' });
        return;
      }

      const validAtlasUrl = await validatePublicUrl(atlasUrl);
      const origin = validAtlasUrl.origin;

      const requestedSounds = soundsParam
        ? Array.from(
            new Set(
              soundsParam
                .split(',')
                .map((s) => s.trim())
                .filter((s) => Boolean(s) && s.length <= 120)
            )
          ).slice(0, 140)
        : [];
      const requestedVideos = videosParam
        ? Array.from(
            new Set(
              videosParam
                .split(',')
                .map((s) => s.trim())
                .filter((s) => Boolean(s) && s.length <= 120)
            )
          ).slice(0, 20)
        : [];
      const requestedFeatures = featuresParam
        ? Array.from(
            new Set(
              featuresParam
                .split(',')
                .map((s) => s.trim())
                .filter((s) => Boolean(s) && s.length <= 120)
            )
          ).slice(0, 24)
        : [];

      const tables = await loadJotaGameTables(origin);
      if (tables) {
        const profile = buildNinjaMediaProfileFromTables(tables, {
          ninjaId,
          code,
          displayName: displayNameParam || undefined,
          requestedSounds,
          requestedVideos,
          requestedFeatures,
        });
        res.setHeader('Cache-Control', 'public, max-age=1800');
        res.json(profile);
        return;
      }

      const code6 = code.length === 8 && code.startsWith('100') ? code.slice(0, 6) : code;
      const resolvedHeroCode = code6 || code;
      const resolvedName = displayNameParam || undefined;
      const soundUrlMap: Record<string, string> = {};
      const videoUrlMap: Record<string, string> = {};
      const videosOut: Array<{
        key: string;
        label: string;
        kind: 'ultimate' | 'recruit';
        url: string;
      }> = [];

      for (const sKey of requestedSounds) {
        const url = resolveSoundUrlFromTables(origin, sKey, {});
        if (url) soundUrlMap[sKey] = url;
      }
      for (const vidSource of requestedVideos) {
        const url = resolveHeroVideoUrlFromTables(origin, vidSource, null, 'ultimate');
        if (url) {
          videoUrlMap[vidSource] = url;
          videosOut.push({
            key: vidSource,
            label: `Vídeo Ultimate (${vidSource})`,
            kind: 'ultimate',
            url,
          });
        }
      }

      const passiveAura = resolvePassiveAuraServer(
        origin,
        ninjaId,
        resolvedHeroCode,
        resolvedName
      );

      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.json({
        ninjaId,
        heroCode: resolvedHeroCode || undefined,
        displayName: resolvedName,
        skills: {},
        passives: [],
        passiveAura,
        videos: videosOut,
        voices: [],
        soundUrlMap,
        videoUrlMap,
        originBase: origin,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar mídia do ninja.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/proxy', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!rawUrl) {
        res.status(400).json({ error: 'Parâmetro url obrigatório.' });
        return;
      }

      const targetUrl = await validatePublicUrl(rawUrl);
      const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
      const safeRange = /^bytes=\d*-\d*$/.test(rawRange) ? rawRange : '';
      const upstream = await fetchWithTimeout(
        targetUrl.toString(),
        18000,
        '*/*',
        safeRange ? { Range: safeRange } : undefined
      );
      if (!upstream.ok && upstream.status !== 206) {
        res.status(upstream.status).json({ error: `Falha ao buscar recurso remoto (HTTP ${upstream.status}).` });
        return;
      }

      const contentLengthHeader = upstream.headers.get('content-length');
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_PROXY_BYTES) {
        res.status(413).json({ error: 'Arquivo excede o limite máximo de 24 MB.' });
        return;
      }

      const arrayBuf = await upstream.arrayBuffer();
      if (arrayBuf.byteLength > MAX_PROXY_BYTES) {
        res.status(413).json({ error: 'Arquivo excede o limite máximo de 24 MB.' });
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const acceptRanges = upstream.headers.get('accept-ranges');
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Content-Length', String(arrayBuf.byteLength));
      res.send(Buffer.from(arrayBuf));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro no proxy de ativos.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/ninja-thumb', async (req, res) => {
    try {
      const atlasUrl = typeof req.query.atlasUrl === 'string' ? req.query.atlasUrl : '';
      const skeletonUrl = typeof req.query.skeletonUrl === 'string' ? req.query.skeletonUrl : '';
      if (!atlasUrl) {
        res.status(400).json({ error: 'Parâmetro atlasUrl obrigatório.' });
        return;
      }

      const cached = thumbMemoryCache.get(atlasUrl);
      if (cached) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(cached);
        return;
      }

      const validAtlasUrl = await validatePublicUrl(atlasUrl);
      const validSkeletonUrl = skeletonUrl ? await validatePublicUrl(skeletonUrl) : null;

      const [atlasResp, skelResp] = await Promise.all([
        fetchWithTimeout(validAtlasUrl.toString(), 10000, 'text/plain,*/*'),
        validSkeletonUrl
          ? fetchWithTimeout(validSkeletonUrl.toString(), 10000, 'application/json,*/*').catch(() => null)
          : Promise.resolve(null),
      ]);

      if (!atlasResp.ok) {
        res.status(404).end();
        return;
      }
      const atlasText = await atlasResp.text();
      const regions = parseAtlasRegionsServer(atlasText);
      if (regions.length === 0) {
        res.status(404).end();
        return;
      }

      const largestRegion = regions.reduce(
        (best, r) => (r.width * r.height > best.width * best.height ? r : best),
        regions[0]
      );
      let targetName = largestRegion.name;
      if (skelResp && skelResp.ok) {
        try {
          const skel = (await skelResp.json()) as {
            animations?: Record<
              string,
              { slots?: Record<string, { attachment?: Array<{ name?: string | null }> }> }
            >;
          };
          const anims = skel?.animations || {};
          const animOrder = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
          for (const animKey of animOrder) {
            const slots = anims[animKey]?.slots;
            if (!slots) continue;
            const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
            let foundMatch = false;
            for (const slotAnim of slotOrder) {
              const firstAtt = slotAnim?.attachment?.find((a) => typeof a.name === 'string');
              if (firstAtt?.name && regions.some((r) => r.name === firstAtt.name)) {
                targetName = firstAtt.name;
                foundMatch = true;
                break;
              }
            }
            if (foundMatch) break;
          }
        } catch {
          // fallback to largest region
        }
      }

      const region = regions.find((r) => r.name === targetName) || largestRegion;
      const pageUrl = resolveRelativeUrl(validAtlasUrl.toString(), region.pageName);
      if (!pageUrl) {
        res.status(404).end();
        return;
      }
      await validatePublicUrl(pageUrl);
      const imgResp = await fetchWithTimeout(pageUrl, 15000, 'image/*,*/*');
      if (!imgResp.ok) {
        res.status(502).end();
        return;
      }

      const buf = Buffer.from(await imgResp.arrayBuffer());
      const ext = region.pageName.split('.').pop()?.toLowerCase() || 'webp';
      const cropW = region.rotate === 90 ? region.height : region.width;
      const cropH = region.rotate === 90 ? region.width : region.height;
      const pngBuf = await cropImageBufferWithConvert(
        buf,
        ext,
        region.x,
        region.y,
        cropW,
        cropH,
        region.rotate
      );

      if (thumbMemoryCache.size > 400) {
        const oldestKey = thumbMemoryCache.keys().next().value;
        if (oldestKey) thumbMemoryCache.delete(oldestKey);
      }
      thumbMemoryCache.set(atlasUrl, pngBuf);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(pngBuf);
    } catch {
      res.status(500).end();
    }
  });

  registerBackupRoutes(app, {
    validatePublicUrl,
    isAllowedJotaHost,
    loadJotaGameTables,
    extractCatalogForUrl,
    buildNinjaMediaProfileFromTables: (tables, params) =>
      buildNinjaMediaProfileFromTables(tables as JotaGameTables, params),
    fetchWithTimeout,
    parseAtlasPageFilenames,
    resolveSoundUrlFromTables,
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled =
      process.env.DISABLE_HMR === 'true' || Boolean(process.env.K_SERVICE);

    if (hmrDisabled) {
      app.get('/@vite/client', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(`const sheetsMap = new Map();
let lastInsertedStyle;

export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => {
        lastInsertedStyle = undefined;
      }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement('afterend', style);
    }
    lastInsertedStyle = style;
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}

export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}

export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    prune() {},
    dispose() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}

export function injectQuery(url) {
  return url;
}

export class ErrorOverlay extends HTMLElement {}
`);
      });
    }

    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: hmrDisabled ? false : { server: httpServer },
        hmr: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Shinobi Sprite Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
