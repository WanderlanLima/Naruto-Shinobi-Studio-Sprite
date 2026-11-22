import type {
  AtlasPage,
  CompositeSpineLayer,
  NinjaEntry,
  NinjaMediaProfile,
  SpineCommandEffectRef,
  SpineSkeleton,
  SpriteRegionSource,
} from '../types/sprite';
import {
  buildRegionSpriteMap,
  canvasToPngBlob,
  computeCompositeAnimationWorldBounds,
  computeNativeExportCellSize,
  downloadBlob,
  exportAnimationGif,
  exportAnimationStripPngBlob,
  extractRegionToPngBlob,
  extractSpineAudioRefs,
  extractSpineEffectRefs,
  extractSpineVideoRefs,
  getAnimationDuration,
  getCompositeAnimationDuration,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
  resolveEffectiveAnimationName,
} from './atlasParser';
import { CHASE_SYSTEM_LEGEND } from './combatMechanicsParser';
import {
  fetchNinjaBundle,
  resolveAssetFetchUrl,
  resolveMediaSoundUrl,
  resolveMediaVideoUrl,
} from './remoteClient';
import { assembleStreamingZipBlob, computeCrc32, type StreamingZipEntry } from './streamingZip';

export type EffectIncludeScope = 'powers' | 'all' | 'base';

export interface CompleteExportOptions {
  effectScope: EffectIncludeScope;
  includeOriginalAndFrames: boolean;
  includeLinkedEffects: boolean;
  includeAnimPngsAndSheets: boolean;
  includeAnimGifs: boolean;
  includePassiveAura?: boolean;
  includeVideosAndAudio?: boolean;
  includeSkillIcons?: boolean;
  mediaProfile?: NinjaMediaProfile | null;
  gifBg: 'transparent' | 'dark' | 'light' | 'chroma';
  fps?: number;
  folderPrefix?: string;
  signal?: AbortSignal;
  effectCache?: Map<string, Promise<ParsedEffectAsset | null>>;
  onProgress?: (info: {
    phase: 'base' | 'effects' | 'media' | 'rendering' | 'zipping';
    message: string;
    percent: number;
  }) => void;
}

export interface BaseCharacterData {
  ninja: NinjaEntry;
  atlasText: string;
  skeleton: SpineSkeleton | null;
  pageUrls: Record<string, string>;
  pageImages: Record<string, HTMLImageElement>;
  regionCanvasMap: Map<string, SpriteRegionSource>;
}

export interface CollectedCharacterFile {
  path: string;
  data: Blob | ArrayBuffer | Uint8Array | string;
}

export interface ParsedEffectAsset {
  spineId: string;
  atlasText: string;
  skeleton: SpineSkeleton;
  pages: AtlasPage[];
  pageUrls: Record<string, string>;
  pageImages: Record<string, HTMLImageElement>;
  regionCanvasMap: Map<string, SpriteRegionSource>;
}

const PRIORITY_ANIM_ORDER = [
  'idle',
  'attack',
  'skill',
  'UniqueSkill',
  'chase1',
  'chase2',
  'chase3',
  'gatilho1',
  'gatilho2',
  'uniqueSkill',
  'superUniqueSkill',
  'run',
  'win',
  'cast',
  'charge',
  'hurt1',
  'die',
];

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Exportação cancelada.', 'AbortError');
  }
}

export function sanitizePathSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'anim';
}

export function getSortedAnimationNames(skeleton: SpineSkeleton | null | undefined): string[] {
  const raw = Object.keys(skeleton?.animations || {});
  return raw.sort((a, b) => {
    const aIdle = a.toLowerCase() === 'idle';
    const bIdle = b.toLowerCase() === 'idle';
    if (aIdle && !bIdle) return -1;
    if (!aIdle && bIdle) return 1;
    const ia = PRIORITY_ANIM_ORDER.indexOf(a);
    const ib = PRIORITY_ANIM_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

export function filterEffectRefsByScope(
  refs: SpineCommandEffectRef[],
  scope: EffectIncludeScope
): SpineCommandEffectRef[] {
  if (scope === 'base') return [];
  if (scope === 'powers') return refs.filter((r) => r.isSelfOrScreen);
  return refs;
}

export function collectCharacterEffectPlan(
  skeleton: SpineSkeleton | null | undefined,
  scope: EffectIncludeScope
): {
  animNames: string[];
  refsByAnim: Map<string, SpineCommandEffectRef[]>;
  uniqueSpineIds: string[];
} {
  const animNames = getSortedAnimationNames(skeleton);
  const refsByAnim = new Map<string, SpineCommandEffectRef[]>();
  const uniqueIds = new Set<string>();

  if (!skeleton) {
    return { animNames, refsByAnim, uniqueSpineIds: [] };
  }

  for (const animName of animNames) {
    const allRefs = extractSpineEffectRefs(skeleton, animName);
    const filtered = filterEffectRefsByScope(allRefs, scope);
    refsByAnim.set(animName, filtered);
    for (const ref of filtered) {
      uniqueIds.add(ref.spineId);
    }
  }

  return {
    animNames,
    refsByAnim,
    uniqueSpineIds: Array.from(uniqueIds),
  };
}

export function buildCharacterInstructionsJson(
  ninjaId: string,
  skeleton: SpineSkeleton,
  scope: EffectIncludeScope,
  effectBundles?: Map<string, ParsedEffectAsset | null>,
  missingEffects?: string[],
  mediaProfile?: NinjaMediaProfile | null
): string {
  const animNames = getSortedAnimationNames(skeleton);
  const animations = animNames.map((animName) => {
    const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
    const baseDurationSec = Number(getAnimationDuration(skeleton, effectiveAnim).toFixed(4));
    const allRefs = extractSpineEffectRefs(skeleton, animName);
    const filteredRefs = filterEffectRefsByScope(allRefs, scope);
    const audioRefs = extractSpineAudioRefs(skeleton, animName);
    const videoRefs = [...extractSpineVideoRefs(skeleton, animName)];
    const seenAnimVideoKeys = new Set(videoRefs.map((v) => v.resolvedName.toLowerCase()));
    for (const mv of mediaProfile?.videos || []) {
      if (mv.kind !== 'ultimate' || !mv.animName) continue;
      const mvAnimLow = mv.animName.toLowerCase();
      if (mvAnimLow !== animName.toLowerCase() && mvAnimLow !== effectiveAnim.toLowerCase()) {
        continue;
      }
      if (seenAnimVideoKeys.has(mv.key.toLowerCase())) continue;
      seenAnimVideoKeys.add(mv.key.toLowerCase());
      videoRefs.push({
        source: mv.key,
        resolvedName: mv.key,
        time: typeof mv.startTime === 'number' ? mv.startTime : 0.25,
        careforward: false,
        layer: 'fg',
        rawCommand: `{HERO_VIDEO:source="${mv.key}"}`,
      });
    }

    let compositeDurationSec = baseDurationSec;
    if (effectBundles) {
      const layers: CompositeSpineLayer[] = [];
      for (const ref of filteredRefs) {
        const eff = effectBundles.get(ref.spineId);
        if (!eff) continue;
        const availAnims = Object.keys(eff.skeleton.animations || {});
        const targetLower = ref.animName.trim().toLowerCase();
        const effAnimName =
          (eff.skeleton.animations?.[ref.animName] ? ref.animName : undefined) ||
          availAnims.find((a) => a.trim().toLowerCase() === targetLower) ||
          availAnims[0];
        if (!effAnimName) continue;
        layers.push({
          spineId: ref.spineId,
          skeleton: eff.skeleton,
          animName: effAnimName,
          regionCanvasMap: eff.regionCanvasMap,
          startTime: ref.startTime,
          duration: getAnimationDuration(eff.skeleton, effAnimName),
          layer: ref.layer,
          loop: ref.loop,
        });
      }
      compositeDurationSec = Number(
        getCompositeAnimationDuration(baseDurationSec, layers).toFixed(4)
      );
    }

    const skillMeta =
      mediaProfile?.skills?.[animName] ||
      mediaProfile?.skills?.[animName.toLowerCase()] ||
      mediaProfile?.skills?.[effectiveAnim] ||
      mediaProfile?.skills?.[effectiveAnim.toLowerCase()];

    return {
      name: animName,
      effectiveAnimation: effectiveAnim !== animName ? effectiveAnim : undefined,
      skillLabel: skillMeta ? `${skillMeta.slotLabel}: ${skillMeta.name}` : undefined,
      skillIconFile: skillMeta?.iconUrl
        ? buildSkillIconRelPathForAnim(skillMeta.animKey, skillMeta.name, skillMeta.iconUrl)
        : undefined,
      baseDurationSec,
      compositeDurationSec,
      effects: allRefs.map((ref) => ({
        spineId: ref.spineId,
        effectAnim: ref.animName,
        startTimeSec: Number(ref.startTime.toFixed(4)),
        layer: ref.layer,
        isSelfOrScreen: ref.isSelfOrScreen,
        includedInScope:
          scope === 'all' || (scope === 'powers' && ref.isSelfOrScreen),
        loop: ref.loop,
        rawCommand: ref.rawCommand,
      })),
      videos:
        videoRefs.length > 0
          ? videoRefs.map((v) => ({
              key: v.resolvedName,
              source: v.source,
              startTimeSec: Number(v.time.toFixed(4)),
              careforward: v.careforward,
              file: `videos/${sanitizePathSegment(v.resolvedName)}.mp4`,
            }))
          : undefined,
      sounds:
        audioRefs.length > 0
          ? audioRefs.map((s) => ({
              soundName: s.soundName,
              timeSec: Number(s.time.toFixed(4)),
              file: `audios/animacoes/${sanitizePathSegment(s.soundName.replace(/\.mp3$/i, ''))}.mp3`,
            }))
          : undefined,
    };
  });

  const skillsWithIconFile =
    mediaProfile?.skills && Object.keys(mediaProfile.skills).length > 0
      ? Object.fromEntries(
          Object.entries(mediaProfile.skills).map(([k, sk]) => [
            k,
            {
              ...sk,
              iconFile: sk.iconUrl
                ? buildSkillIconRelPathForAnim(sk.animKey, sk.name, sk.iconUrl)
                : undefined,
            },
          ])
        )
      : undefined;

  const passivesWithIconFile =
    mediaProfile?.passives && mediaProfile.passives.length > 0
      ? mediaProfile.passives.map((p, idx) => ({
          ...p,
          iconFile: p.iconUrl
            ? buildPassiveIconRelPath(idx, p.name, p.iconUrl)
            : undefined,
        }))
      : undefined;

  return JSON.stringify(
    {
      characterId: ninjaId,
      heroCode: mediaProfile?.heroCode,
      displayName: mediaProfile?.displayName,
      atlasFile: `${ninjaId}.atlas`,
      skeletonFile: `${ninjaId}.json`,
      combatFile: 'combate_e_habilidades.json',
      effectScope: scope,
      notes:
        'As definicoes completas de ossos, slots, keyframes e eventos @CMD ficam no arquivo .json (skeleton). As mecanicas de combate, gatilhos de perseguicao (Queda/Flutuacao/Empurrao), efeitos/debuffs aplicados e atributos base ficam em combate_e_habilidades.json (e resumidos abaixo). Icones das skills em qualidade maxima ficam em icones_skills/, particulas em particulas/<spineId>/, videos de ultimate em videos/*.mp4 e vozes/efeitos sonoros em audios/*.mp3.',
      chaseSystemLegend: CHASE_SYSTEM_LEGEND,
      combatProfile: mediaProfile?.combatProfile,
      skills: skillsWithIconFile,
      passives: passivesWithIconFile,
      passiveAura: mediaProfile?.passiveAura
        ? {
            id: mediaProfile.passiveAura.id,
            label: mediaProfile.passiveAura.label,
            folder: `particulas/${sanitizePathSegment(mediaProfile.passiveAura.id)}/`,
            layers: mediaProfile.passiveAura.layers,
          }
        : undefined,
      voices:
        mediaProfile?.voices && mediaProfile.voices.length > 0
          ? mediaProfile.voices.map((v) => ({
              key: v.key,
              category: v.category,
              label: v.label,
              file: `audios/vozes/${sanitizePathSegment(`${v.category}_${v.key}`)}.mp3`,
            }))
          : undefined,
      videos:
        mediaProfile?.videos && mediaProfile.videos.length > 0
          ? mediaProfile.videos.map((v) => ({
              key: v.key,
              label: v.label,
              kind: v.kind,
              animName: v.animName,
              startTimeSec: v.startTime,
              file: `videos/${sanitizePathSegment(v.key)}.mp4`,
            }))
          : undefined,
      missingEffects: missingEffects && missingEffects.length > 0 ? missingEffects : undefined,
      animations,
    },
    null,
    2
  );
}

/**
 * Builds a dedicated, game-engine-ready JSON describing the character's combat mechanics:
 * chase combo triggers & caused states (fall/popup/launcher/back), applied debuffs/buffs,
 * target types, elements, passives, and base combat attributes.
 */
export function buildCharacterCombatJson(
  ninjaId: string,
  mediaProfile?: NinjaMediaProfile | null
): string | null {
  if (!mediaProfile) return null;
  const hasSkills = mediaProfile.skills && Object.keys(mediaProfile.skills).length > 0;
  const hasPassives = mediaProfile.passives && mediaProfile.passives.length > 0;
  if (!mediaProfile.combatProfile && !hasSkills && !hasPassives) return null;

  const skillsWithIconFile = hasSkills
    ? Object.fromEntries(
        Object.entries(mediaProfile.skills).map(([k, sk]) => [
          k,
          {
            ...sk,
            iconFile: sk.iconUrl
              ? buildSkillIconRelPathForAnim(sk.animKey, sk.name, sk.iconUrl)
              : undefined,
          },
        ])
      )
    : {};

  const passivesWithIconFile = hasPassives
    ? mediaProfile.passives.map((p, idx) => ({
        ...p,
        iconFile: p.iconUrl
          ? buildPassiveIconRelPath(idx, p.name, p.iconUrl)
          : undefined,
      }))
    : [];

  return JSON.stringify(
    {
      schemaVersion: 'shinobi-combat-v1',
      characterId: ninjaId,
      heroCode: mediaProfile.heroCode,
      displayName: mediaProfile.displayName,
      chaseSystemLegend: CHASE_SYSTEM_LEGEND,
      combatProfile: mediaProfile.combatProfile,
      skills: skillsWithIconFile,
      passives: passivesWithIconFile,
    },
    null,
    2
  );
}

async function fetchRawPageOrFallbackBlob(
  proxyUrl: string,
  fallbackImg: HTMLImageElement | undefined,
  signal?: AbortSignal
): Promise<ArrayBuffer | Blob | null> {
  try {
    const resp = await fetch(proxyUrl, { signal: signal ?? AbortSignal.timeout(20_000) });
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 0) return buf;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
  }

  if (fallbackImg && fallbackImg.naturalWidth > 0 && fallbackImg.naturalHeight > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = fallbackImg.naturalWidth;
    canvas.height = fallbackImg.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(fallbackImg, 0, 0);
      return await canvasToPngBlob(canvas);
    }
  }
  return null;
}

export async function fetchParsedEffectAsset(
  baseAtlasUrl: string,
  spineId: string,
  signal?: AbortSignal,
  cache?: Map<string, Promise<ParsedEffectAsset | null>>,
  explicitUrls?: { atlasUrl: string; skeletonUrl: string }
): Promise<ParsedEffectAsset | null> {
  throwIfAborted(signal);
  let atlasUrl: string;
  let skeletonUrl: string;
  try {
    atlasUrl = explicitUrls?.atlasUrl || new URL(`${spineId}.atlas`, baseAtlasUrl).toString();
    skeletonUrl = explicitUrls?.skeletonUrl || new URL(`${spineId}.json`, baseAtlasUrl).toString();
  } catch {
    return null;
  }

  const existing = cache?.get(atlasUrl);
  if (existing) return existing;

  const task = (async (): Promise<ParsedEffectAsset | null> => {
    try {
      const data = await fetchNinjaBundle(atlasUrl, skeletonUrl);
      if (!data.skeleton) return null;
      throwIfAborted(signal);

      const pages = parseAtlas(data.atlasText);
      const pageImages: Record<string, HTMLImageElement> = {};
      await Promise.all(
        Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
          pageImages[pageName] = await loadImageElement(proxyUrl);
        })
      );
      throwIfAborted(signal);

      const regionCanvasMap = buildRegionSpriteMap(pages, pageImages);

      return {
        spineId,
        atlasText: data.atlasText,
        skeleton: data.skeleton,
        pages,
        pageUrls: data.pageUrls,
        pageImages,
        regionCanvasMap,
      };
    } catch (err) {
      cache?.delete(atlasUrl);
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return null;
    }
  })();

  if (cache) {
    if (cache.size >= 36) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(atlasUrl, task);
  }

  return task;
}

function getGifBgColor(gifBg: CompleteExportOptions['gifBg']): string | null {
  if (gifBg === 'dark') return '#090D14';
  if (gifBg === 'light') return '#F8FAFC';
  if (gifBg === 'chroma') return '#00B140';
  return null;
}

const MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024;

async function fetchBinaryAssetSafe(
  targetUrl: string,
  signal?: AbortSignal
): Promise<ArrayBuffer | null> {
  try {
    const fetchUrl = resolveAssetFetchUrl(targetUrl);
    if (!fetchUrl) return null;
    const resp = await fetch(fetchUrl, { signal: signal ?? AbortSignal.timeout(25_000) });
    if (!resp.ok) return null;
    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength > MAX_MEDIA_FILE_BYTES) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_MEDIA_FILE_BYTES) return null;
    return buf;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return null;
  }
}

const SKILL_ICON_SLOT_PREFIX: Record<string, string> = {
  attack: '01_ataque_normal',
  skill: '02_habilidade',
  UniqueSkill: '03_ultimate',
  chase1: '04_perseguicao_1',
  chase2: '05_perseguicao_2',
  chase3: '06_perseguicao_3',
};

const SKILL_SLOT_ORDER = ['attack', 'skill', 'UniqueSkill', 'chase1', 'chase2', 'chase3'];

function getUrlImageExt(url: string): string {
  const m = url.split('?')[0].match(/\.(png|webp|jpe?g|gif)$/i);
  if (!m) return 'png';
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

function detectImageExtFromBytes(buf: ArrayBuffer, fallbackExt: string): string {
  const bytes = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  return fallbackExt || 'png';
}

function sanitizeSkillSlug(name: string): string {
  const clean = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'skill';
}

export function buildSkillIconRelPathForAnim(
  animKey: string,
  skillName: string,
  iconUrl: string
): string {
  const slotPrefix = SKILL_ICON_SLOT_PREFIX[animKey] || sanitizePathSegment(animKey);
  const ext = getUrlImageExt(iconUrl);
  return `icones_skills/${slotPrefix}_${sanitizeSkillSlug(skillName)}.${ext}`;
}

export function buildPassiveIconRelPath(
  index: number,
  passiveName: string,
  iconUrl: string
): string {
  const ext = getUrlImageExt(iconUrl);
  return `icones_skills/passiva_${String(index + 1).padStart(2, '0')}_${sanitizeSkillSlug(passiveName)}.${ext}`;
}

export interface SkillIconExportTarget {
  baseRelPath: string;
  url: string;
  fallbackExt: string;
}

export function getOrderedSkillIconTargets(
  mediaProfile: NinjaMediaProfile | null | undefined
): SkillIconExportTarget[] {
  if (!mediaProfile) return [];
  const targets: SkillIconExportTarget[] = [];
  const usedBase = new Set<string>();

  const pushTarget = (baseRelPath: string, url: string) => {
    let candidate = baseRelPath;
    let suffix = 2;
    while (usedBase.has(candidate.toLowerCase())) {
      candidate = `${baseRelPath}_${suffix++}`;
    }
    usedBase.add(candidate.toLowerCase());
    targets.push({ baseRelPath: candidate, url, fallbackExt: getUrlImageExt(url) });
  };

  const skillsMap = mediaProfile.skills || {};
  const seenKeys = new Set<string>();
  for (const key of SKILL_SLOT_ORDER) {
    const sk = skillsMap[key];
    if (!sk?.iconUrl) continue;
    seenKeys.add(key);
    const slotPrefix = SKILL_ICON_SLOT_PREFIX[key] || sanitizePathSegment(key);
    pushTarget(`icones_skills/${slotPrefix}_${sanitizeSkillSlug(sk.name)}`, sk.iconUrl);
  }
  for (const [key, sk] of Object.entries(skillsMap)) {
    if (seenKeys.has(key) || !sk?.iconUrl) continue;
    pushTarget(`icones_skills/${sanitizePathSegment(key)}_${sanitizeSkillSlug(sk.name)}`, sk.iconUrl);
  }

  const passives = mediaProfile.passives || [];
  passives.forEach((p, idx) => {
    if (!p?.iconUrl) return;
    pushTarget(
      `icones_skills/passiva_${String(idx + 1).padStart(2, '0')}_${sanitizeSkillSlug(p.name)}`,
      p.iconUrl
    );
  });

  return targets;
}

export async function collectCharacterSkillIconFiles(
  mediaProfile: NinjaMediaProfile | null | undefined,
  folderPrefix?: string,
  signal?: AbortSignal
): Promise<CollectedCharacterFile[]> {
  throwIfAborted(signal);
  const targets = getOrderedSkillIconTargets(mediaProfile);
  if (targets.length === 0) return [];

  const prefix = folderPrefix ? `${folderPrefix.replace(/\/+$/, '')}/` : '';
  const files: CollectedCharacterFile[] = [];
  const used = new Set<string>();

  for (let i = 0; i < targets.length; i += 6) {
    throwIfAborted(signal);
    const batch = targets.slice(i, i + 6);
    const results = await Promise.all(
      batch.map(async (item) => ({
        item,
        buf: await fetchBinaryAssetSafe(item.url, signal),
      }))
    );
    for (const { item, buf } of results) {
      if (!buf) continue;
      const ext = detectImageExtFromBytes(buf, item.fallbackExt);
      const fullPath = `${prefix}${item.baseRelPath}.${ext}`;
      if (used.has(fullPath)) continue;
      used.add(fullPath);
      files.push({ path: fullPath, data: buf });
    }
  }

  return files;
}

export async function collectCharacterMediaFiles(params: {
  ninja: NinjaEntry;
  skeleton: SpineSkeleton | null;
  mediaProfile?: NinjaMediaProfile | null;
  includePassiveAura?: boolean;
  includeVideosAndAudio?: boolean;
  includeSkillIcons?: boolean;
  sliceAuraFrames?: boolean;
  folderPrefix?: string;
  signal?: AbortSignal;
  effectCache?: Map<string, Promise<ParsedEffectAsset | null>>;
}): Promise<{
  files: CollectedCharacterFile[];
  passiveAuraAsset: ParsedEffectAsset | null;
}> {
  throwIfAborted(params.signal);
  const prefix = params.folderPrefix ? `${params.folderPrefix.replace(/\/+$/, '')}/` : '';
  const files: CollectedCharacterFile[] = [];
  const used = new Set<string>();
  const push = (relPath: string, data: Blob | ArrayBuffer | Uint8Array | string) => {
    const full = `${prefix}${relPath.replace(/^\/+/, '')}`;
    if (used.has(full)) return;
    used.add(full);
    files.push({ path: full, data });
  };

  let passiveAuraAsset: ParsedEffectAsset | null = null;
  const mediaProfile = params.mediaProfile;

  // 1. Passive idle aura raw package (+ sliced frames)
  if (params.includePassiveAura !== false && mediaProfile?.passiveAura) {
    const aura = mediaProfile.passiveAura;
    passiveAuraAsset = await fetchParsedEffectAsset(
      params.ninja.atlasUrl,
      aura.id,
      params.signal,
      params.effectCache,
      { atlasUrl: aura.atlasUrl, skeletonUrl: aura.skeletonUrl }
    );
    if (passiveAuraAsset) {
      const auraDir = `particulas/${sanitizePathSegment(aura.id)}`;
      push(`${auraDir}/${aura.id}.atlas`, passiveAuraAsset.atlasText);
      push(`${auraDir}/${aura.id}.json`, JSON.stringify(passiveAuraAsset.skeleton, null, 2));
      for (const [pageName, proxyUrl] of Object.entries(passiveAuraAsset.pageUrls)) {
        throwIfAborted(params.signal);
        const sheetData = await fetchRawPageOrFallbackBlob(
          proxyUrl,
          passiveAuraAsset.pageImages[pageName],
          params.signal
        );
        if (sheetData) push(`${auraDir}/${pageName}`, sheetData);
      }
      if (params.sliceAuraFrames !== false) {
        for (const page of passiveAuraAsset.pages) {
          const img = passiveAuraAsset.pageImages[page.name];
          if (!img) continue;
          const blobs = await Promise.all(
            page.regions.map(async (region) => {
              const frameName = region.index >= 0 ? `${region.name}_${region.index}` : region.name;
              const blob = await extractRegionToPngBlob(region, img);
              return blob
                ? { path: `${auraDir}/frames/${sanitizePathSegment(frameName)}.png`, blob }
                : null;
            })
          );
          for (const item of blobs) {
            if (item) push(item.path, item.blob);
          }
        }
      }
    }
  }

  // 2. Ultimate / Recruit MP4 Videos + Animation SFX & Character Voices (MP3)
  if (params.includeVideosAndAudio !== false) {
    const videoTargets = new Map<string, string>();
    const soundTargets = new Map<string, string>();

    if (mediaProfile?.videos?.length) {
      for (const v of mediaProfile.videos) {
        if (v.key && v.url) videoTargets.set(v.key, v.url);
      }
    }

    if (params.skeleton?.animations) {
      for (const animName of Object.keys(params.skeleton.animations)) {
        for (const vRef of extractSpineVideoRefs(params.skeleton, animName)) {
          const url = resolveMediaVideoUrl(vRef, mediaProfile, params.ninja.atlasUrl);
          if (url && !videoTargets.has(vRef.resolvedName)) {
            videoTargets.set(vRef.resolvedName, url);
          }
        }
        for (const sRef of extractSpineAudioRefs(params.skeleton, animName)) {
          const clean = sRef.soundName.replace(/\.mp3$/i, '');
          const url = resolveMediaSoundUrl(clean, mediaProfile, params.ninja.atlasUrl);
          if (url && !soundTargets.has(clean)) {
            soundTargets.set(clean, url);
          }
        }
      }
    }

    // Download MP4 videos
    for (const [key, url] of videoTargets.entries()) {
      throwIfAborted(params.signal);
      const buf = await fetchBinaryAssetSafe(url, params.signal);
      if (buf) {
        push(`videos/${sanitizePathSegment(key)}.mp4`, buf);
      }
    }

    // Download animation SFX MP3s (up to 64 unique clips, batched 4 at a time)
    const soundList = Array.from(soundTargets.entries()).slice(0, 64);
    for (let i = 0; i < soundList.length; i += 4) {
      throwIfAborted(params.signal);
      const batch = soundList.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(async ([key, url]) => ({
          key,
          buf: await fetchBinaryAssetSafe(url, params.signal),
        }))
      );
      for (const item of results) {
        if (item.buf) {
          push(`audios/animacoes/${sanitizePathSegment(item.key)}.mp3`, item.buf);
        }
      }
    }

    // Download character voice clips (MP3)
    const voices = mediaProfile?.voices || [];
    for (let i = 0; i < voices.length; i += 4) {
      throwIfAborted(params.signal);
      const batch = voices.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(async (v) => ({
          v,
          buf: await fetchBinaryAssetSafe(v.url, params.signal),
        }))
      );
      for (const item of results) {
        if (item.buf) {
          push(
            `audios/vozes/${sanitizePathSegment(`${item.v.category}_${item.v.key}`)}.mp3`,
            item.buf
          );
        }
      }
    }
  }

  // 3. Skill & Passive Icons (maximum lossless quality)
  if (params.includeSkillIcons !== false && mediaProfile) {
    const iconFiles = await collectCharacterSkillIconFiles(mediaProfile, undefined, params.signal);
    for (const ic of iconFiles) {
      push(ic.path, ic.data);
    }
  }

  return { files, passiveAuraAsset };
}

export async function collectCharacterCompleteFiles(
  baseData: BaseCharacterData,
  options: CompleteExportOptions
): Promise<CollectedCharacterFile[]> {
  throwIfAborted(options.signal);

  const prefix = options.folderPrefix ? `${options.folderPrefix.replace(/\/+$/, '')}/` : '';
  const files: CollectedCharacterFile[] = [];
  const usedPaths = new Set<string>();

  const pushFile = (relPath: string, data: Blob | ArrayBuffer | Uint8Array | string) => {
    const cleanRel = relPath.replace(/^\/+/, '');
    const fullPath = `${prefix}${cleanRel}`;
    if (usedPaths.has(fullPath)) return;
    usedPaths.add(fullPath);
    files.push({ path: fullPath, data });
  };

  const basePages = parseAtlas(baseData.atlasText);

  // 1. Original character package + sliced PNG frames
  if (options.includeOriginalAndFrames) {
    options.onProgress?.({
      phase: 'base',
      message: `Fatiando frames base de ${baseData.ninja.id}...`,
      percent: 5,
    });

    pushFile(`${baseData.ninja.id}.atlas`, baseData.atlasText);
    if (baseData.skeleton) {
      pushFile(`${baseData.ninja.id}.json`, JSON.stringify(baseData.skeleton, null, 2));
    }

    for (const [pageName, proxyUrl] of Object.entries(baseData.pageUrls)) {
      throwIfAborted(options.signal);
      const sheetData = await fetchRawPageOrFallbackBlob(
        proxyUrl,
        baseData.pageImages[pageName],
        options.signal
      );
      if (sheetData) {
        pushFile(pageName, sheetData);
      }
    }

    for (const page of basePages) {
      const img = baseData.pageImages[page.name];
      if (!img) continue;
      const slicedBlobs = await Promise.all(
        page.regions.map(async (region) => {
          const frameName = region.index >= 0 ? `${region.name}_${region.index}` : region.name;
          const blob = await extractRegionToPngBlob(region, img);
          return blob ? { path: `frames/${sanitizePathSegment(frameName)}.png`, blob } : null;
        })
      );
      for (const item of slicedBlobs) {
        if (item) pushFile(item.path, item.blob);
      }
    }
  }

  const plan = collectCharacterEffectPlan(baseData.skeleton, options.effectScope);
  const needsEffects =
    Boolean(baseData.skeleton) &&
    options.effectScope !== 'base' &&
    (options.includeLinkedEffects ||
      options.includeAnimPngsAndSheets ||
      options.includeAnimGifs);

  // 2. Fetch linked particle bundles (noe_*)
  const effectBundles = new Map<string, ParsedEffectAsset | null>();
  const missingEffects: string[] = [];

  if (needsEffects && plan.uniqueSpineIds.length > 0) {
    for (let i = 0; i < plan.uniqueSpineIds.length; i++) {
      throwIfAborted(options.signal);
      const spineId = plan.uniqueSpineIds[i];
      const pct = 10 + Math.round(((i + 1) / plan.uniqueSpineIds.length) * 18);
      options.onProgress?.({
        phase: 'effects',
        message: `Baixando partículas (${i + 1}/${plan.uniqueSpineIds.length}): ${spineId}...`,
        percent: pct,
      });

      const parsed = await fetchParsedEffectAsset(
        baseData.ninja.atlasUrl,
        spineId,
        options.signal,
        options.effectCache
      );
      effectBundles.set(spineId, parsed);
      if (!parsed) {
        missingEffects.push(spineId);
      }
    }
  }

  // 2.5 Fetch passive idle aura, ultimate MP4 videos, MP3 voices/sounds & skill icons
  let passiveAuraAsset: ParsedEffectAsset | null = null;
  const wantPassiveAura = options.includePassiveAura !== false && Boolean(options.mediaProfile?.passiveAura);
  const wantMediaFiles = options.includeVideosAndAudio !== false;
  const wantSkillIcons =
    options.includeSkillIcons !== false &&
    getOrderedSkillIconTargets(options.mediaProfile).length > 0;

  if (wantPassiveAura || wantMediaFiles || wantSkillIcons) {
    options.onProgress?.({
      phase: 'media',
      message: `Baixando ícones das skills, aura passiva e mídias de ${baseData.ninja.id}...`,
      percent: 28,
    });
    const mediaResult = await collectCharacterMediaFiles({
      ninja: baseData.ninja,
      skeleton: baseData.skeleton,
      mediaProfile: options.mediaProfile,
      includePassiveAura: wantPassiveAura,
      includeVideosAndAudio: wantMediaFiles,
      includeSkillIcons: wantSkillIcons,
      sliceAuraFrames: options.includeLinkedEffects || options.includeOriginalAndFrames,
      signal: options.signal,
      effectCache: options.effectCache,
    });
    passiveAuraAsset = mediaResult.passiveAuraAsset;
    for (const mf of mediaResult.files) {
      pushFile(mf.path, mf.data);
    }
  }

  // 3. Export animation instructions JSON + dedicated combat/skills/chase mechanics JSON
  if (
    baseData.skeleton &&
    (options.includeLinkedEffects ||
      options.includeAnimPngsAndSheets ||
      options.includeAnimGifs ||
      wantPassiveAura ||
      wantMediaFiles ||
      wantSkillIcons)
  ) {
    pushFile(
      'animacoes_instrucoes.json',
      buildCharacterInstructionsJson(
        baseData.ninja.id,
        baseData.skeleton,
        options.effectScope,
        effectBundles,
        missingEffects,
        options.mediaProfile
      )
    );
  }

  const combatJson = buildCharacterCombatJson(baseData.ninja.id, options.mediaProfile);
  if (combatJson) {
    pushFile('combate_e_habilidades.json', combatJson);
  }

  if (options.includeLinkedEffects && options.effectScope !== 'base') {
    for (const [spineId, eff] of effectBundles.entries()) {
      if (!eff) continue;
      throwIfAborted(options.signal);
      const effDir = `particulas/${sanitizePathSegment(spineId)}`;
      pushFile(`${effDir}/${spineId}.atlas`, eff.atlasText);
      pushFile(`${effDir}/${spineId}.json`, JSON.stringify(eff.skeleton, null, 2));

      for (const [pageName, proxyUrl] of Object.entries(eff.pageUrls)) {
        throwIfAborted(options.signal);
        const sheetData = await fetchRawPageOrFallbackBlob(
          proxyUrl,
          eff.pageImages[pageName],
          options.signal
        );
        if (sheetData) {
          pushFile(`${effDir}/${pageName}`, sheetData);
        }
      }

      for (const page of eff.pages) {
        const img = eff.pageImages[page.name];
        if (!img) continue;
        const blobs = await Promise.all(
          page.regions.map(async (region) => {
            const frameName = region.index >= 0 ? `${region.name}_${region.index}` : region.name;
            const blob = await extractRegionToPngBlob(region, img);
            return blob
              ? { path: `${effDir}/frames/${sanitizePathSegment(frameName)}.png`, blob }
              : null;
          })
        );
        for (const item of blobs) {
          if (item) pushFile(item.path, item.blob);
        }
      }
    }
  }

  // 4. Render all animations composited with their particles (+ passive aura on idle)
  if (
    baseData.skeleton &&
    plan.animNames.length > 0 &&
    (options.includeAnimPngsAndSheets || options.includeAnimGifs)
  ) {
    const fps = options.fps ?? 24;
    const bgColor = getGifBgColor(options.gifBg);
    const frameCanvas = document.createElement('canvas');

    const passiveAuraLayers: CompositeSpineLayer[] = [];
    if (wantPassiveAura && passiveAuraAsset && options.mediaProfile?.passiveAura) {
      const auraAvail = Object.keys(passiveAuraAsset.skeleton.animations || {});
      for (const auraLayer of options.mediaProfile.passiveAura.layers) {
        const target =
          auraAvail.find((a) => a === auraLayer.loopAnim) ||
          auraAvail.find((a) => a.toLowerCase() === auraLayer.loopAnim.toLowerCase()) ||
          auraAvail[0];
        if (!target) continue;
        passiveAuraLayers.push({
          spineId: options.mediaProfile.passiveAura.id,
          skeleton: passiveAuraAsset.skeleton,
          animName: target,
          regionCanvasMap: passiveAuraAsset.regionCanvasMap,
          startTime: 0,
          duration: getAnimationDuration(passiveAuraAsset.skeleton, target),
          layer: auraLayer.layer,
          loop: true,
        });
      }
    }

    for (let aIdx = 0; aIdx < plan.animNames.length; aIdx++) {
      throwIfAborted(options.signal);
      const animName = plan.animNames[aIdx];
      const effectiveAnim = resolveEffectiveAnimationName(baseData.skeleton, animName);
      const safeAnim = sanitizePathSegment(animName);
      const animDir = `animacoes/${safeAnim}`;
      const refs = plan.refsByAnim.get(animName) || [];

      const layers: CompositeSpineLayer[] = [];
      if (effectiveAnim.toLowerCase() === 'idle' && passiveAuraLayers.length > 0) {
        layers.push(...passiveAuraLayers);
      }

      for (const ref of refs) {
        const eff = effectBundles.get(ref.spineId);
        if (!eff) continue;
        const availAnims = Object.keys(eff.skeleton.animations || {});
        const targetLower = ref.animName.trim().toLowerCase();
        const effAnimName =
          (eff.skeleton.animations?.[ref.animName] ? ref.animName : undefined) ||
          availAnims.find((a) => a.trim().toLowerCase() === targetLower) ||
          availAnims[0];
        if (!effAnimName) continue;
        layers.push({
          spineId: ref.spineId,
          skeleton: eff.skeleton,
          animName: effAnimName,
          regionCanvasMap: eff.regionCanvasMap,
          startTime: ref.startTime,
          duration: getAnimationDuration(eff.skeleton, effAnimName),
          layer: ref.layer,
          loop: ref.loop,
        });
      }

      const baseDuration = getAnimationDuration(baseData.skeleton, effectiveAnim);
      const totalDuration = getCompositeAnimationDuration(baseDuration, layers);
      const bounds = computeCompositeAnimationWorldBounds(
        baseData.skeleton,
        effectiveAnim,
        baseData.regionCanvasMap,
        layers,
        24
      );

      const basePct = 32 + Math.round((aIdx / plan.animNames.length) * 56);
      options.onProgress?.({
        phase: 'rendering',
        message: `Renderizando animação "${animName}" (${aIdx + 1}/${plan.animNames.length})...`,
        percent: basePct,
      });

      if (options.includeAnimPngsAndSheets) {
        const frameCount =
          totalDuration <= 0 ? 1 : Math.max(1, Math.min(240, Math.round(totalDuration * fps)));
        const { width: cellW, height: cellH } = computeNativeExportCellSize(bounds, 2048);
        frameCanvas.width = cellW;
        frameCanvas.height = cellH;
        const ctx = frameCanvas.getContext('2d');

        if (ctx) {
          for (let f = 0; f < frameCount; f++) {
            throwIfAborted(options.signal);
            const t = frameCount === 1 ? 0 : (f / frameCount) * totalDuration;
            renderSpineFrameToCanvas(
              ctx,
              cellW,
              cellH,
              baseData.skeleton,
              effectiveAnim,
              t,
              baseData.regionCanvasMap,
              1,
              0,
              0,
              bounds,
              layers
            );
            const pngBlob = await canvasToPngBlob(frameCanvas);
            if (pngBlob) {
              pushFile(
                `${animDir}/frames/${safeAnim}_${String(f).padStart(3, '0')}.png`,
                pngBlob
              );
            }
            if (f % 6 === 5) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }

        const strip = await exportAnimationStripPngBlob(
          baseData.skeleton,
          effectiveAnim,
          baseData.regionCanvasMap,
          fps,
          layers,
          bounds
        );
        if (strip.blob) {
          pushFile(`${animDir}/${safeAnim}_spritesheet.png`, strip.blob);
        }
      }

      if (options.includeAnimGifs) {
        throwIfAborted(options.signal);
        const gifRes = await exportAnimationGif(
          baseData.skeleton,
          effectiveAnim,
          baseData.regionCanvasMap,
          {
            fps,
            bounds,
            backgroundColor: bgColor,
            compositeLayers: layers,
          }
        );
        pushFile(`${animDir}/${safeAnim}.gif`, gifRes.blob);
      }

      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return files;
}

export async function exportCompleteCharacterZip(
  baseData: BaseCharacterData,
  options: CompleteExportOptions
): Promise<{ fileCount: number; zipFilename: string }> {
  const folderName = sanitizePathSegment(baseData.ninja.id);
  const collected = await collectCharacterCompleteFiles(baseData, {
    ...options,
    folderPrefix: options.folderPrefix ?? folderName,
  });

  throwIfAborted(options.signal);
  options.onProgress?.({
    phase: 'zipping',
    message: `Empacotando ${collected.length} arquivos no ZIP...`,
    percent: 90,
  });

  const textEncoder = new TextEncoder();
  const entries: StreamingZipEntry[] = [];

  for (let i = 0; i < collected.length; i++) {
    throwIfAborted(options.signal);
    const item = collected[i];
    let bytes: Uint8Array;
    let blob: Blob;

    if (typeof item.data === 'string') {
      bytes = textEncoder.encode(item.data);
      blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: 'text/plain;charset=utf-8',
      });
    } else if (item.data instanceof Blob) {
      const ab = await item.data.arrayBuffer();
      bytes = new Uint8Array(ab);
      blob = item.data;
    } else if (item.data instanceof Uint8Array) {
      bytes = item.data;
      blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
    } else {
      bytes = new Uint8Array(item.data);
      blob = new Blob([item.data]);
    }

    entries.push({
      path: item.path,
      size: bytes.byteLength,
      crc32: computeCrc32(bytes),
      blob,
    });
  }

  const zipBlob = await assembleStreamingZipBlob(
    async function* (): AsyncGenerator<StreamingZipEntry[]> {
      for (let i = 0; i < entries.length; i += 24) {
        yield entries.slice(i, i + 24);
      }
    },
    entries.length,
    (pct) => {
      options.onProgress?.({
        phase: 'zipping',
        message: `Montando arquivo ZIP (${pct}%)...`,
        percent: 90 + Math.round(pct * 0.1),
      });
    }
  );

  const zipFilename = `${folderName}_completo.zip`;
  downloadBlob(zipBlob, zipFilename);
  return { fileCount: entries.length, zipFilename };
}
