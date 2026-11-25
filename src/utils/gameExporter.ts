import { GIFEncoder } from 'gifenc';
import type {
  NinjaEntry,
  NinjaMediaProfile,
  SpineAudioEventRef,
  SpineCommandEffectRef,
  SpineSkeleton,
  SpineVideoEventRef,
  SpriteRegionSource,
} from '../types/sprite';
import {
  buildRegionSpriteMap,
  canvasToPngBlob,
  computeAnimationWorldBounds,
  detectAttackEmitterBoneName,
  downloadBlob,
  extractSpineAudioRefs,
  extractSpineEffectRefs,
  extractSpineVideoRefs,
  findMatchingCompanionAnimName,
  getAnimationDuration,
  hasVisibleAnimationContent,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
  resolveEffectiveAnimationName,
  sampleAttackEmitterPointAtTime,
  writeQuantizedGifFrame,
} from './atlasParser';
import {
  buildCharacterCombatJson,
  buildCharacterInstructionsJson,
  fetchParsedEffectAsset,
  type ParsedEffectAsset,
} from './completeCharacterExporter';
import { exportWorkerPool } from './exportWorkerPool';
import {
  buildAnimationEventsTimelineMs,
  buildGameEngineSpritesheetJson,
  buildPhaserMultiAtlasJson,
  computeAnimationAnchorMetrics,
  type FrameEmitterPoint,
  type MultiAtlasPageSpec,
} from './gameEngineExportMeta';
import {
  isOfflineBackupActive,
  isStrictOfflineMode,
  readOfflineEntryBytes,
} from './offlineZipStore';
import {
  discoverCompanionEffectSpines,
  fetchNinjaBundle,
  fetchNinjaMediaProfile,
  resolveAssetFetchUrl,
  resolveMediaSoundUrl,
  resolveMediaVideoUrl,
} from './remoteClient';
import { assembleStreamingZipBlob, computeCrc32, type StreamingZipEntry } from './streamingZip';

export const MAX_GAME_SHEET_SIDE = 2048;
export const MAX_GAME_FILE_BYTES = 20 * 1024 * 1024;
/** Safety margin so ZIP headers + central directory never push a split part over 20 MB */
export const MAX_SPLIT_ZIP_PART_BYTES = Math.floor(19.4 * 1024 * 1024);

export type GameAnimRoleKey =
  | 'idle'
  | 'move'
  | 'jump'
  | 'fall'
  | 'attack'
  | 'skill'
  | 'ultimate'
  | 'hurt'
  | 'die'
  | 'win';

export interface SelectedGameAnimation {
  role: GameAnimRoleKey;
  /** Distinct role slot key (e.g. "idle", "attack", "skill_1", "skill_2", "ultimate") */
  roleSlot: string;
  /** Normalized lowercase ASCII slug used for file naming */
  slug: string;
  /** Real animation name in the Spine skeleton that holds the visual pose */
  effectiveAnim: string;
  /** Primary original animation name (for display/mapping) */
  originalAnim: string;
  /** All original skeleton animation names (including wrappers) whose events should be merged */
  sourceAnims: string[];
  /** True for attack, skills/jutsus, and ultimate (enables per-frame emitterPoints) */
  isCombatAction: boolean;
}

export interface GameExportOptions {
  includeEffects: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includeGifs: boolean;
  fps: number;
}

export interface GameExportFile {
  /** Normalized lowercase path relative to export root (e.g. characters/naruto/anims/idle.png) */
  path: string;
  bytes: Uint8Array;
}

export interface GameCharacterManifestAnim {
  slug: string;
  originalName: string;
  role: GameAnimRoleKey;
  roleSlot: string;
  fps: number;
  frameCount: number;
  durationMs: number;
  cellWidth: number;
  cellHeight: number;
  multiatlas: boolean;
  jsonFile: string;
  imageFiles: string[];
  gifFile?: string;
  hasEmitterPoints: boolean;
}

export interface GameCharacterManifest {
  schemaVersion: 'shinobi-phaser-v1';
  id: string;
  originalId: string;
  code: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  facing: 'right' | 'left';
  roles: {
    idle?: string;
    move?: string;
    jump?: string;
    fall?: string;
    attack?: string;
    skills: string[];
    ultimate?: string;
    hurt?: string;
    die?: string;
    win?: string;
  };
  roleToOriginalAnim: {
    idle?: string;
    move?: string;
    jump?: string;
    fall?: string;
    attack?: string;
    skills: Record<string, string>;
    ultimate?: string;
    hurt?: string;
    die?: string;
    win?: string;
  };
  animations: GameCharacterManifestAnim[];
  effects: Array<{
    spineId: string;
    originalSpineId: string;
    animSlug: string;
    originalAnim: string;
    jsonFile: string;
    imageFiles: string[];
  }>;
  audio: Array<{
    name: string;
    originalName: string;
    file: string;
  }>;
  videos?: Array<{
    name: string;
    originalName: string;
    file: string;
  }>;
  files: string[];
}

export interface GameIndexCharacterEntry {
  id: string;
  originalId: string;
  code: string;
  name: string;
  path: string;
  characterJson: string;
  width: number;
  height: number;
  fps: number;
  facing: 'right' | 'left';
  roles: GameCharacterManifest['roles'];
  fileCount: number;
  totalBytes: number;
  files: string[];
}

export interface GameRootIndex {
  schemaVersion: 'shinobi-phaser-index-v1';
  generatedAt: string;
  totalCharacters: number;
  characters: GameIndexCharacterEntry[];
}

export interface BuiltGameCharacterResult {
  characterIdSlug: string;
  manifest: GameCharacterManifest;
  indexEntry: GameIndexCharacterEntry;
  files: GameExportFile[];
  skippedWarnings: string[];
}

const textEncoder = new TextEncoder();

/**
 * Strictly normalizes any identifier or filename segment to lowercase ASCII,
 * removing accents, spaces, and special characters.
 */
export function toGameSlug(raw: string, fallback = 'item'): string {
  const clean = String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return clean || fallback;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Exportação cancelada.', 'AbortError');
  }
}

function yieldTick(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.onmessage = null;
        ch.port1.close();
        ch.port2.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function detectFacingDirection(skeleton: SpineSkeleton): 'right' | 'left' {
  const root = (skeleton.bones || []).find((b) => b.name.toLowerCase() === 'root') || skeleton.bones?.[0];
  if (root && typeof root.scaleX === 'number' && root.scaleX < 0) {
    return 'left';
  }
  return 'right';
}

function pickBestCandidate(
  available: string[],
  matchers: RegExp[],
  usedEffective: Set<string>,
  skeleton: SpineSkeleton
): string | null {
  for (const rx of matchers) {
    const match = available.find((name) => {
      if (!rx.test(name)) return false;
      const eff = resolveEffectiveAnimationName(skeleton, name);
      if (usedEffective.has(eff.toLowerCase())) return false;
      return hasVisibleAnimationContent(skeleton, eff);
    });
    if (match) return match;
  }
  return null;
}

/**
 * Selects ONLY the core gameplay animations required for Phaser 3:
 * idle, move (walk/run), jump, fall, attack, each skill/jutsu, ultimate, hurt, die, win.
 * Deduplicates wrapper animations (e.g. `attackAction` -> `attack`) while preserving all events.
 */
export function selectGameAnimationsForSkeleton(
  skeleton: SpineSkeleton,
  mediaProfile?: NinjaMediaProfile | null
): {
  selected: SelectedGameAnimation[];
  roles: GameCharacterManifest['roles'];
  roleToOriginalAnim: GameCharacterManifest['roleToOriginalAnim'];
} {
  const allAnims = Object.keys(skeleton.animations || {});
  const wrappersByEffective = new Map<string, string[]>();
  for (const name of allAnims) {
    const eff = resolveEffectiveAnimationName(skeleton, name);
    const key = eff.toLowerCase();
    const list = wrappersByEffective.get(key) || [];
    if (!list.includes(name)) list.push(name);
    wrappersByEffective.set(key, list);
  }

  const usedEffective = new Set<string>();
  const usedSlugs = new Set<string>();
  const selected: SelectedGameAnimation[] = [];

  const roles: GameCharacterManifest['roles'] = { skills: [] };
  const roleToOriginalAnim: GameCharacterManifest['roleToOriginalAnim'] = { skills: {} };

  const makeUniqueSlug = (rawName: string, fallback: string): string => {
    const base = toGameSlug(rawName, fallback);
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    let idx = 2;
    while (usedSlugs.has(`${base}_${idx}`)) idx++;
    const uniq = `${base}_${idx}`;
    usedSlugs.add(uniq);
    return uniq;
  };

  const registerSelection = (
    rawName: string,
    role: GameAnimRoleKey,
    roleSlot: string,
    isCombatAction: boolean
  ): SelectedGameAnimation | null => {
    const effectiveAnim = resolveEffectiveAnimationName(skeleton, rawName);
    const effKey = effectiveAnim.toLowerCase();
    if (usedEffective.has(effKey)) return null;
    if (!hasVisibleAnimationContent(skeleton, effectiveAnim)) return null;

    usedEffective.add(effKey);
    const sources = Array.from(
      new Set([rawName, effectiveAnim, ...(wrappersByEffective.get(effKey) || [])])
    );
    const slug = makeUniqueSlug(effectiveAnim, roleSlot);

    const entry: SelectedGameAnimation = {
      role,
      roleSlot,
      slug,
      effectiveAnim,
      originalAnim: rawName,
      sourceAnims: sources,
      isCombatAction,
    };
    selected.push(entry);
    return entry;
  };

  // 1. Idle
  const idleRaw = pickBestCandidate(
    allAnims,
    [/^idle$/i, /^idle_?1$/i, /^stand$/i, /^wait$/i, /^daiji$/i, /^idle/i],
    usedEffective,
    skeleton
  );
  if (idleRaw) {
    const sel = registerSelection(idleRaw, 'idle', 'idle', false);
    if (sel) {
      roles.idle = sel.slug;
      roleToOriginalAnim.idle = sel.originalAnim;
    }
  }

  // 2. Move (walk/run)
  const moveRaw = pickBestCandidate(
    allAnims,
    [/^run$/i, /^walk$/i, /^move$/i, /^run_?1$/i, /^dash$/i, /^pao$/i, /^run/i, /^walk/i],
    usedEffective,
    skeleton
  );
  if (moveRaw) {
    const sel = registerSelection(moveRaw, 'move', 'move', false);
    if (sel) {
      roles.move = sel.slug;
      roleToOriginalAnim.move = sel.originalAnim;
    }
  }

  // 3. Jump & Fall
  const jumpRaw = pickBestCandidate(
    allAnims,
    [/^jump$/i, /^fly$/i, /^tiao$/i, /^d_stand_air$/i, /^d_stand_air1$/i, /^up$/i, /^jump/i],
    usedEffective,
    skeleton
  );
  if (jumpRaw) {
    const sel = registerSelection(jumpRaw, 'jump', 'jump', false);
    if (sel) {
      roles.jump = sel.slug;
      roleToOriginalAnim.jump = sel.originalAnim;
    }
  }

  const fallRaw = pickBestCandidate(
    allAnims,
    [/^fall$/i, /^d_air_land$/i, /^d_air_land1$/i, /^down$/i, /^fall/i],
    usedEffective,
    skeleton
  );
  if (fallRaw) {
    const sel = registerSelection(fallRaw, 'fall', 'fall', false);
    if (sel) {
      roles.fall = sel.slug;
      roleToOriginalAnim.fall = sel.originalAnim;
    }
  }

  // 4. Normal Attack
  const attackRaw = pickBestCandidate(
    allAnims,
    [/^attack$/i, /^attack_?1$/i, /^attackaction$/i, /^pugong$/i, /^normal_?attack$/i],
    usedEffective,
    skeleton
  );
  if (attackRaw) {
    const sel = registerSelection(attackRaw, 'attack', 'attack', true);
    if (sel) {
      roles.attack = sel.slug;
      roleToOriginalAnim.attack = sel.originalAnim;
    }
  }

  // 5. Ultimate (select before generic skills so UniqueSkill gets the ultimate role)
  const ultRaw = pickBestCandidate(
    allAnims,
    [
      /^UniqueSkill$/,
      /^uniqueskill$/i,
      /^superuniqueskill$/i,
      /^ultimate$/i,
      /^ult$/i,
      /^esoterica$/i,
      /^aoyi$/i,
      /unique.*skill/i,
    ],
    usedEffective,
    skeleton
  );
  if (ultRaw) {
    const sel = registerSelection(ultRaw, 'ultimate', 'ultimate', true);
    if (sel) {
      roles.ultimate = sel.slug;
      roleToOriginalAnim.ultimate = sel.originalAnim;
    }
  }

  // 6. Skills / Jutsus (every distinct skill, chase, gatilho, extra superUniqueSkill, or mediaProfile skill)
  const skillCandidates: string[] = [];
  const pushCandidate = (name: string) => {
    if (!skillCandidates.includes(name) && skeleton.animations?.[name]) {
      skillCandidates.push(name);
    }
  };

  // Prefer skills known in mediaProfile first (in natural order)
  if (mediaProfile?.skills) {
    for (const k of Object.keys(mediaProfile.skills)) {
      if (skeleton.animations?.[k]) pushCandidate(k);
      const ci = allAnims.find((a) => a.toLowerCase() === k.toLowerCase());
      if (ci) pushCandidate(ci);
    }
  }

  const skillPatterns = [
    /^skill$/i,
    /^skill_?\d+$/i,
    /^skillaction$/i,
    /^chase_?\d*$/i,
    /^chase_?\d*action$/i,
    /^gatilho_?\d*$/i,
    /^jutsu_?\d*$/i,
    /^superuniqueskill$/i,
    /^attack_?[2-9]$/i,
    /^cast$/i,
    /^charge$/i,
  ];
  for (const rx of skillPatterns) {
    for (const name of allAnims) {
      if (rx.test(name)) pushCandidate(name);
    }
  }

  let skillIdx = 1;
  for (const cand of skillCandidates) {
    const roleSlot = `skill_${skillIdx}`;
    const sel = registerSelection(cand, 'skill', roleSlot, true);
    if (sel) {
      roles.skills.push(sel.slug);
      roleToOriginalAnim.skills[sel.slug] = sel.originalAnim;
      skillIdx++;
    }
  }

  // 7. Hurt
  const hurtRaw = pickBestCandidate(
    allAnims,
    [/^hurt1$/i, /^hurt$/i, /^hurt2$/i, /^behit$/i, /^hit$/i, /^damage$/i, /^d_stand_behit1$/i],
    usedEffective,
    skeleton
  );
  if (hurtRaw) {
    const sel = registerSelection(hurtRaw, 'hurt', 'hurt', false);
    if (sel) {
      roles.hurt = sel.slug;
      roleToOriginalAnim.hurt = sel.originalAnim;
    }
  }

  // 8. Die
  const dieRaw = pickBestCandidate(
    allAnims,
    [/^die$/i, /^death$/i, /^dead$/i, /^ko$/i, /^die_?1$/i],
    usedEffective,
    skeleton
  );
  if (dieRaw) {
    const sel = registerSelection(dieRaw, 'die', 'die', false);
    if (sel) {
      roles.die = sel.slug;
      roleToOriginalAnim.die = sel.originalAnim;
    }
  }

  // 9. Win / Victory
  const winRaw = pickBestCandidate(
    allAnims,
    [/^win$/i, /^victory$/i, /^win_?1$/i, /^shengli$/i, /^show$/i],
    usedEffective,
    skeleton
  );
  if (winRaw) {
    const sel = registerSelection(winRaw, 'win', 'win', false);
    if (sel) {
      roles.win = sel.slug;
      roleToOriginalAnim.win = sel.originalAnim;
    }
  }

  // Safety net: if a skeleton had none of the above names, include its first visible animation as idle
  if (selected.length === 0) {
    const fallback = allAnims.find((a) => hasVisibleAnimationContent(skeleton, a));
    if (fallback) {
      const sel = registerSelection(fallback, 'idle', 'idle', false);
      if (sel) {
        roles.idle = sel.slug;
        roleToOriginalAnim.idle = sel.originalAnim;
      }
    }
  }

  return { selected, roles, roleToOriginalAnim };
}

/**
 * Computes exact 1:1 original cell dimensions for a skeleton animation, clamped only
 * if a single frame itself exceeds 2048x2048 px.
 */
function computeOneToOneCellSize(bounds: { width: number; height: number }): {
  cellW: number;
  cellH: number;
} {
  let cellW = Math.max(64, Math.ceil(bounds.width + 12));
  let cellH = Math.max(64, Math.ceil(bounds.height + 12));
  if (cellW > MAX_GAME_SHEET_SIDE || cellH > MAX_GAME_SHEET_SIDE) {
    const ratio = Math.min(MAX_GAME_SHEET_SIDE / cellW, MAX_GAME_SHEET_SIDE / cellH);
    cellW = Math.max(64, Math.floor(cellW * ratio));
    cellH = Math.max(64, Math.floor(cellH * ratio));
  }
  return { cellW, cellH };
}

function planSpriteSheetPages(
  frameCount: number,
  cellW: number,
  cellH: number,
  maxFramesPerPageOverride?: number
): Array<{ cols: number; rows: number; width: number; height: number; frameIndices: number[] }> {
  const maxCols = Math.max(1, Math.floor(MAX_GAME_SHEET_SIDE / cellW));
  const maxRows = Math.max(1, Math.floor(MAX_GAME_SHEET_SIDE / cellH));
  const naturalCapacity = Math.max(1, maxCols * maxRows);
  const perPage = maxFramesPerPageOverride
    ? Math.max(1, Math.min(naturalCapacity, maxFramesPerPageOverride))
    : naturalCapacity;

  const pages: Array<{
    cols: number;
    rows: number;
    width: number;
    height: number;
    frameIndices: number[];
  }> = [];

  for (let start = 0; start < frameCount; start += perPage) {
    const end = Math.min(frameCount, start + perPage);
    const count = end - start;
    const frameIndices: number[] = [];
    for (let f = start; f < end; f++) frameIndices.push(f);

    // Choose a near-square grid that fits strictly within MAX_GAME_SHEET_SIDE x MAX_GAME_SHEET_SIDE
    let cols = Math.min(count, maxCols, Math.max(1, Math.ceil(Math.sqrt((count * cellH) / Math.max(1, cellW)))));
    let rows = Math.ceil(count / cols);
    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.min(maxCols, Math.ceil(count / rows));
    }

    pages.push({
      cols,
      rows,
      width: cols * cellW,
      height: rows * cellH,
      frameIndices,
    });
  }

  return pages;
}

async function encodeCanvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  try {
    const blob = await exportWorkerPool.encodeCanvasToPng(canvas);
    if (blob && blob.size > 0) {
      return new Uint8Array(await blob.arrayBuffer());
    }
  } catch {
    // Fallback to main-thread canvas.toBlob
  }
  const fallback = await canvasToPngBlob(canvas);
  if (!fallback || fallback.size === 0) return null;
  return new Uint8Array(await fallback.arrayBuffer());
}

async function fetchBinaryCapped(
  targetUrl: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array | null; skippedTooLarge?: boolean }> {
  try {
    throwIfAborted(signal);
    if (isOfflineBackupActive()) {
      const offlineBuf = await readOfflineEntryBytes(targetUrl);
      if (offlineBuf && offlineBuf.byteLength > 0) {
        if (offlineBuf.byteLength > maxBytes) {
          return { bytes: null, skippedTooLarge: true };
        }
        return { bytes: new Uint8Array(offlineBuf) };
      }
      if (isStrictOfflineMode()) return { bytes: null };
    }
    const fetchUrl = resolveAssetFetchUrl(targetUrl);
    if (!fetchUrl) return { bytes: null };
    const resp = await fetch(fetchUrl, { signal: signal ?? AbortSignal.timeout(25_000) });
    if (!resp.ok) return { bytes: null };
    const cl = Number(resp.headers.get('content-length') || 0);
    if (cl > maxBytes) return { bytes: null, skippedTooLarge: true };
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0) return { bytes: null };
    if (buf.byteLength > maxBytes) return { bytes: null, skippedTooLarge: true };
    return { bytes: new Uint8Array(buf) };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { bytes: null };
  }
}

async function renderSkeletonAnimationToPhaserFiles(params: {
  characterIdSlug: string;
  skeleton: SpineSkeleton;
  effectiveAnim: string;
  originalAnim: string;
  animSlug: string;
  regionCanvasMap: Map<string, SpriteRegionSource>;
  fps: number;
  baseRelDir: string;
  events: ReturnType<typeof buildAnimationEventsTimelineMs>;
  collectEmitterPoints: boolean;
  facing: 'right' | 'left';
  includeGif: boolean;
  signal?: AbortSignal;
}): Promise<{
  files: GameExportFile[];
  imageFiles: string[];
  jsonFile: string;
  gifFile?: string;
  frameCount: number;
  durationMs: number;
  cellW: number;
  cellH: number;
  multiatlas: boolean;
  hasEmitterPoints: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const durationSec = getAnimationDuration(params.skeleton, params.effectiveAnim);
  const frameCount =
    durationSec <= 0 ? 1 : Math.max(1, Math.min(180, Math.round(durationSec * params.fps)));
  const bounds = computeAnimationWorldBounds(
    params.skeleton,
    params.effectiveAnim,
    params.regionCanvasMap,
    24
  );
  const { cellW, cellH } = computeOneToOneCellSize(bounds);
  const anchor = computeAnimationAnchorMetrics(bounds, cellW, cellH, 1, 1);

  const emitterBone = params.collectEmitterPoints
    ? detectAttackEmitterBoneName(params.skeleton)
    : null;
  const emitterPoints: FrameEmitterPoint[] = [];

  if (params.collectEmitterPoints) {
    for (let f = 0; f < frameCount; f++) {
      const t = frameCount === 1 ? 0 : (f / frameCount) * durationSec;
      const pt = sampleAttackEmitterPointAtTime(
        params.skeleton,
        params.effectiveAnim,
        t,
        params.regionCanvasMap,
        anchor.worldToPixelScale,
        params.facing,
        emitterBone
      );
      emitterPoints.push({
        frame: f,
        timeMs: Math.round(t * 1000),
        x: pt.x,
        y: pt.y,
        bone: pt.bone,
        source: pt.source,
      });
    }
  }

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: params.includeGif });

  const sheetCanvas = document.createElement('canvas');
  let maxFramesOverride: number | undefined = undefined;
  let encodedPages: Array<{
    spec: MultiAtlasPageSpec;
    bytes: Uint8Array;
  }> = [];

  // Re-pack with smaller pages if any PNG somehow exceeds MAX_GAME_FILE_BYTES (20 MB)
  for (let pass = 0; pass < 3; pass++) {
    throwIfAborted(params.signal);
    const pagePlans = planSpriteSheetPages(frameCount, cellW, cellH, maxFramesOverride);
    const isMulti = pagePlans.length > 1;
    encodedPages = [];
    let exceeded20Mb = false;

    for (let pIdx = 0; pIdx < pagePlans.length; pIdx++) {
      throwIfAborted(params.signal);
      const page = pagePlans[pIdx];
      sheetCanvas.width = page.width;
      sheetCanvas.height = page.height;
      const sheetCtx = sheetCanvas.getContext('2d');
      if (!sheetCtx || !frameCtx) continue;
      sheetCtx.clearRect(0, 0, page.width, page.height);
      sheetCtx.imageSmoothingEnabled = true;
      sheetCtx.imageSmoothingQuality = 'high';

      for (let localIdx = 0; localIdx < page.frameIndices.length; localIdx++) {
        throwIfAborted(params.signal);
        const f = page.frameIndices[localIdx];
        const t = frameCount === 1 ? 0 : (f / frameCount) * durationSec;
        renderSpineFrameToCanvas(
          frameCtx,
          cellW,
          cellH,
          params.skeleton,
          params.effectiveAnim,
          t,
          params.regionCanvasMap,
          1,
          0,
          0,
          bounds,
          [],
          { fillRatio: 1, maxAutoFitScale: 1 }
        );
        const col = localIdx % page.cols;
        const row = Math.floor(localIdx / page.cols);
        sheetCtx.drawImage(frameCanvas, col * cellW, row * cellH);

        if (localIdx % 10 === 9) {
          await yieldTick();
        }
      }

      const pngBytes = await encodeCanvasToPngBytes(sheetCanvas);
      if (!pngBytes) continue;

      if (pngBytes.byteLength > MAX_GAME_FILE_BYTES && page.frameIndices.length > 1) {
        exceeded20Mb = true;
        maxFramesOverride = Math.max(1, Math.floor(page.frameIndices.length / 2));
        break;
      }

      const imageFilename = isMulti
        ? `${params.animSlug}_p${pIdx}.png`
        : `${params.animSlug}.png`;

      encodedPages.push({
        spec: {
          imageFilename,
          width: page.width,
          height: page.height,
          cols: page.cols,
          rows: page.rows,
          frameIndices: page.frameIndices,
        },
        bytes: pngBytes,
      });
    }

    if (!exceeded20Mb) break;
  }

  const outFiles: GameExportFile[] = [];
  const imageFiles: string[] = [];
  const multiatlas = encodedPages.length > 1;

  for (const page of encodedPages) {
    if (page.bytes.byteLength > MAX_GAME_FILE_BYTES) {
      warnings.push(`${page.spec.imageFilename} excedeu 20 MB e foi ignorado.`);
      continue;
    }
    const relImg = `${params.baseRelDir}/${page.spec.imageFilename}`;
    outFiles.push({ path: relImg, bytes: page.bytes });
    imageFiles.push(relImg);
  }

  const jsonRel = `${params.baseRelDir}/${params.animSlug}.json`;
  const jsonText = multiatlas
    ? buildPhaserMultiAtlasJson({
        characterId: params.characterIdSlug,
        animName: params.originalAnim,
        safeAnimName: params.animSlug,
        pages: encodedPages.map((p) => p.spec),
        frameCount,
        cellW,
        cellH,
        fps: params.fps,
        durationSec,
        anchor,
        events: params.events,
        emitterPoints: emitterPoints.length > 0 ? emitterPoints : undefined,
        emitterBone,
      })
    : buildGameEngineSpritesheetJson({
        characterId: params.characterIdSlug,
        animName: params.originalAnim,
        safeAnimName: params.animSlug,
        imageFilename: encodedPages[0]?.spec.imageFilename || `${params.animSlug}.png`,
        frameCount,
        cols: encodedPages[0]?.spec.cols || 1,
        rows: encodedPages[0]?.spec.rows || 1,
        cellW,
        cellH,
        fps: params.fps,
        durationSec,
        anchor,
        events: params.events,
        emitterPoints: emitterPoints.length > 0 ? emitterPoints : undefined,
        emitterBone,
      });

  outFiles.push({ path: jsonRel, bytes: textEncoder.encode(jsonText) });

  // Optional GIF (OFF by default)
  let gifFile: string | undefined;
  if (params.includeGif && frameCtx) {
    const gifMax = 512;
    let gifW = cellW;
    let gifH = cellH;
    if (gifW > gifMax || gifH > gifMax) {
      const r = Math.min(gifMax / gifW, gifMax / gifH);
      gifW = Math.max(32, Math.floor(gifW * r));
      gifH = Math.max(32, Math.floor(gifH * r));
    }
    const gifCanvas = document.createElement('canvas');
    gifCanvas.width = gifW;
    gifCanvas.height = gifH;
    const gifCtx = gifCanvas.getContext('2d', { willReadFrequently: true });
    if (gifCtx) {
      const encoder = GIFEncoder();
      const delayMs =
        durationSec <= 0 ? 100 : Math.max(20, Math.round((durationSec / frameCount) * 1000));
      for (let f = 0; f < frameCount; f++) {
        throwIfAborted(params.signal);
        const t = frameCount === 1 ? 0 : (f / frameCount) * durationSec;
        renderSpineFrameToCanvas(
          frameCtx,
          cellW,
          cellH,
          params.skeleton,
          params.effectiveAnim,
          t,
          params.regionCanvasMap,
          1,
          0,
          0,
          bounds,
          [],
          { fillRatio: 1, maxAutoFitScale: 1 }
        );
        gifCtx.clearRect(0, 0, gifW, gifH);
        gifCtx.drawImage(frameCanvas, 0, 0, cellW, cellH, 0, 0, gifW, gifH);
        const imgData = gifCtx.getImageData(0, 0, gifW, gifH);
        const q = await exportWorkerPool.quantizeGifFrame(
          imgData.data.buffer as ArrayBuffer,
          gifW,
          gifH,
          false
        );
        writeQuantizedGifFrame(encoder, q, gifW, gifH, delayMs);
      }
      encoder.finish();
      const gifBytes = new Uint8Array(encoder.bytes());
      if (gifBytes.byteLength <= MAX_GAME_FILE_BYTES) {
        gifFile = `${params.baseRelDir}/${params.animSlug}.gif`;
        outFiles.push({ path: gifFile, bytes: gifBytes });
      }
    }
    gifCanvas.width = 0;
    gifCanvas.height = 0;
  }

  // Release canvas GPU memory immediately (critical on Android Chrome)
  frameCanvas.width = 0;
  frameCanvas.height = 0;
  sheetCanvas.width = 0;
  sheetCanvas.height = 0;

  return {
    files: outFiles,
    imageFiles,
    jsonFile: jsonRel,
    gifFile,
    frameCount,
    durationMs: Math.round(durationSec * 1000),
    cellW,
    cellH,
    multiatlas,
    hasEmitterPoints: emitterPoints.length > 0,
    warnings,
  };
}

/**
 * Builds the complete lightweight Phaser 3 export bundle for a single ninja,
 * reusing existing atlas/skeleton/combat/media helpers.
 */
export async function buildGameExportForNinja(params: {
  ninja: NinjaEntry;
  options: GameExportOptions;
  effectCache?: Map<string, Promise<ParsedEffectAsset | null>>;
  onStep?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<BuiltGameCharacterResult> {
  const { ninja, options, signal } = params;
  throwIfAborted(signal);

  const idSlug = toGameSlug(ninja.id, 'ninja');
  const charRoot = `characters/${idSlug}`;
  const skippedWarnings: string[] = [];

  params.onStep?.(`Carregando esqueleto e atlas de ${ninja.name || ninja.id}...`);
  const [bundle, mediaProfile] = await Promise.all([
    fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl),
    fetchNinjaMediaProfile(ninja, null).catch(() => null),
  ]);
  throwIfAborted(signal);

  if (!bundle.skeleton) {
    throw new Error(`Esqueleto Spine indisponível para ${ninja.id}.`);
  }

  const skeleton = bundle.skeleton;
  // Hydrate mediaProfile with skeleton events if needed
  const fullMediaProfile: NinjaMediaProfile | null =
    mediaProfile || (await fetchNinjaMediaProfile(ninja, skeleton).catch(() => null));

  const pages = parseAtlas(bundle.atlasText);
  const pageImages: Record<string, HTMLImageElement> = {};
  await Promise.all(
    Object.entries(bundle.pageUrls).map(async ([pageName, url]) => {
      pageImages[pageName] = await loadImageElement(url);
    })
  );
  throwIfAborted(signal);

  const regionCanvasMap = buildRegionSpriteMap(pages, pageImages);
  const facing = detectFacingDirection(skeleton);
  const fps = Math.max(8, Math.min(60, Math.round(options.fps || 24)));

  const { selected, roles, roleToOriginalAnim } = selectGameAnimationsForSkeleton(
    skeleton,
    fullMediaProfile
  );

  // Collect all unique effects, audio, and videos ONLY from the selected animations
  const usedEffectRefsByAnim = new Map<string, SpineCommandEffectRef[]>();
  const usedAudioRefsByAnim = new Map<string, SpineAudioEventRef[]>();
  const usedVideoRefsByAnim = new Map<string, SpineVideoEventRef[]>();
  const uniqueEffectPairs = new Map<
    string,
    { spineId: string; animName: string; isCompanion?: boolean; explicitUrls?: { atlasUrl: string; skeletonUrl: string } }
  >();
  const uniqueSoundNames = new Map<string, string>(); // slug -> originalName
  const uniqueVideoRefs = new Map<string, SpineVideoEventRef>();

  const companionDescriptors = options.includeEffects
    ? await discoverCompanionEffectSpines(ninja)
    : [];

  for (const sel of selected) {
    const mergedEffects: SpineCommandEffectRef[] = [];
    const seenEff = new Set<string>();
    const mergedAudio: SpineAudioEventRef[] = [];
    const seenAud = new Set<string>();
    const mergedVideos: SpineVideoEventRef[] = [];
    const seenVid = new Set<string>();

    for (const srcAnim of sel.sourceAnims) {
      for (const ref of extractSpineEffectRefs(skeleton, srcAnim)) {
        const key = `${ref.spineId}::${ref.animName}::${ref.startTime.toFixed(3)}`;
        if (!seenEff.has(key)) {
          seenEff.add(key);
          mergedEffects.push(ref);
        }
      }
      for (const aud of extractSpineAudioRefs(skeleton, srcAnim)) {
        const key = `${aud.soundName}::${aud.time.toFixed(3)}`;
        if (!seenAud.has(key)) {
          seenAud.add(key);
          mergedAudio.push(aud);
        }
      }
      for (const vid of extractSpineVideoRefs(skeleton, srcAnim)) {
        const key = `${vid.resolvedName}::${vid.time.toFixed(3)}`;
        if (!seenVid.has(key)) {
          seenVid.add(key);
          mergedVideos.push(vid);
        }
      }
    }

    usedEffectRefsByAnim.set(sel.slug, mergedEffects);
    usedAudioRefsByAnim.set(sel.slug, mergedAudio);
    usedVideoRefsByAnim.set(sel.slug, mergedVideos);

    if (options.includeEffects) {
      for (const ref of mergedEffects) {
        const pk = `${ref.spineId.toLowerCase()}::${ref.animName.toLowerCase()}`;
        if (!uniqueEffectPairs.has(pk)) {
          uniqueEffectPairs.set(pk, { spineId: ref.spineId, animName: ref.animName });
        }
      }
    }
    if (options.includeAudio) {
      for (const aud of mergedAudio) {
        const cleanOrig = aud.soundName.replace(/\.mp3$/i, '');
        const slug = toGameSlug(cleanOrig, 'sfx');
        if (!uniqueSoundNames.has(slug)) {
          uniqueSoundNames.set(slug, cleanOrig);
        }
      }
    }
    if (options.includeVideos) {
      for (const vid of mergedVideos) {
        const slug = toGameSlug(vid.resolvedName, 'video');
        if (!uniqueVideoRefs.has(slug)) {
          uniqueVideoRefs.set(slug, vid);
        }
      }
    }
  }

  // Load companion effect spines for classic ninjas and check which selected anims match
  const effectBundles = new Map<string, ParsedEffectAsset | null>();
  if (options.includeEffects && companionDescriptors.length > 0) {
    for (const comp of companionDescriptors) {
      throwIfAborted(signal);
      const parsed = await fetchParsedEffectAsset(
        ninja.atlasUrl,
        comp.spineId,
        signal,
        params.effectCache,
        { atlasUrl: comp.atlasUrl, skeletonUrl: comp.skeletonUrl }
      );
      if (!parsed) continue;
      effectBundles.set(comp.spineId, parsed);
      for (const sel of selected) {
        const matched = findMatchingCompanionAnimName(
          parsed.skeleton,
          sel.originalAnim,
          sel.effectiveAnim
        );
        if (!matched) continue;
        const pk = `${comp.spineId.toLowerCase()}::${matched.toLowerCase()}`;
        if (!uniqueEffectPairs.has(pk)) {
          uniqueEffectPairs.set(pk, {
            spineId: comp.spineId,
            animName: matched,
            isCompanion: true,
          });
        }
        const list = usedEffectRefsByAnim.get(sel.slug) || [];
        list.unshift({
          spineId: comp.spineId,
          animName: matched,
          startTime: 0,
          layer: comp.layer,
          isSelfOrScreen: true,
          loop: false,
          rawCommand: `{COMPANION:spine="${comp.spineId}",source="${matched}"}`,
        });
        usedEffectRefsByAnim.set(sel.slug, list);
      }
    }
  }

  const allFiles: GameExportFile[] = [];
  const usedPaths = new Set<string>();
  const pushFile = (path: string, bytes: Uint8Array) => {
    const clean = path.replace(/^\/+/, '');
    if (usedPaths.has(clean)) return;
    usedPaths.add(clean);
    allFiles.push({ path: clean, bytes });
  };

  // 1. Render selected character animations -> characters/<id>/anims/<anim>.png + .json
  const manifestAnims: GameCharacterManifestAnim[] = [];
  let charWidth = Math.max(64, Math.round(ninja.width || skeleton.skeleton?.width || 160));
  let charHeight = Math.max(64, Math.round(ninja.height || skeleton.skeleton?.height || 160));

  for (let i = 0; i < selected.length; i++) {
    throwIfAborted(signal);
    const sel = selected[i];
    params.onStep?.(
      `${ninja.name || ninja.id} · renderizando "${sel.slug}" (${i + 1}/${selected.length})...`
    );

    const effRefs = usedEffectRefsByAnim.get(sel.slug) || [];
    const audRefs = usedAudioRefsByAnim.get(sel.slug) || [];
    const vidRefs = usedVideoRefsByAnim.get(sel.slug) || [];

    // Remap event names to lowercase slugs so Phaser code can directly look up effects/audio files
    const normalizedEvents = buildAnimationEventsTimelineMs(
      options.includeEffects
        ? effRefs.map((r) => ({
            ...r,
            spineId: toGameSlug(r.spineId, 'effect'),
            animName: toGameSlug(r.animName, 'anim'),
          }))
        : [],
      options.includeAudio
        ? audRefs.map((a) => ({
            ...a,
            soundName: toGameSlug(a.soundName.replace(/\.mp3$/i, ''), 'sfx'),
          }))
        : [],
      options.includeVideos
        ? vidRefs.map((v) => ({
            ...v,
            resolvedName: toGameSlug(v.resolvedName, 'video'),
          }))
        : []
    );

    const rendered = await renderSkeletonAnimationToPhaserFiles({
      characterIdSlug: idSlug,
      skeleton,
      effectiveAnim: sel.effectiveAnim,
      originalAnim: sel.originalAnim,
      animSlug: sel.slug,
      regionCanvasMap,
      fps,
      baseRelDir: `${charRoot}/anims`,
      events: normalizedEvents,
      collectEmitterPoints: sel.isCombatAction,
      facing,
      includeGif: options.includeGifs,
      signal,
    });

    if (sel.role === 'idle') {
      charWidth = rendered.cellW;
      charHeight = rendered.cellH;
    }

    for (const f of rendered.files) pushFile(f.path, f.bytes);
    skippedWarnings.push(...rendered.warnings);

    manifestAnims.push({
      slug: sel.slug,
      originalName: sel.originalAnim,
      role: sel.role,
      roleSlot: sel.roleSlot,
      fps,
      frameCount: rendered.frameCount,
      durationMs: rendered.durationMs,
      cellWidth: rendered.cellW,
      cellHeight: rendered.cellH,
      multiatlas: rendered.multiatlas,
      jsonFile: rendered.jsonFile.slice(charRoot.length + 1),
      imageFiles: rendered.imageFiles.map((p) => p.slice(charRoot.length + 1)),
      ...(rendered.gifFile ? { gifFile: rendered.gifFile.slice(charRoot.length + 1) } : {}),
      hasEmitterPoints: rendered.hasEmitterPoints,
    });
  }

  // 2. Render ONLY the standalone effects referenced by the exported animations
  const manifestEffects: GameCharacterManifest['effects'] = [];
  const missingEffects: string[] = [];

  if (options.includeEffects && uniqueEffectPairs.size > 0) {
    const uniqueSpines = Array.from(
      new Set(Array.from(uniqueEffectPairs.values()).map((p) => p.spineId))
    ).filter((sid) => !effectBundles.has(sid));

    for (let i = 0; i < uniqueSpines.length; i += 4) {
      throwIfAborted(signal);
      const batch = uniqueSpines.slice(i, i + 4);
      const loaded = await Promise.all(
        batch.map(async (sid) => ({
          sid,
          asset: await fetchParsedEffectAsset(ninja.atlasUrl, sid, signal, params.effectCache),
        }))
      );
      for (const { sid, asset } of loaded) {
        effectBundles.set(sid, asset);
        if (!asset) missingEffects.push(sid);
      }
    }

    const pairs = Array.from(uniqueEffectPairs.values());
    const exportedEffectKeys = new Set<string>();

    for (let i = 0; i < pairs.length; i++) {
      throwIfAborted(signal);
      const pair = pairs[i];
      const effAsset = effectBundles.get(pair.spineId);
      if (!effAsset) continue;

      const avail = Object.keys(effAsset.skeleton.animations || {});
      const targetLower = pair.animName.trim().toLowerCase();
      const matchedAnim =
        (effAsset.skeleton.animations?.[pair.animName] ? pair.animName : undefined) ||
        avail.find((a) => a.trim().toLowerCase() === targetLower) ||
        avail[0];
      if (!matchedAnim || !hasVisibleAnimationContent(effAsset.skeleton, matchedAnim)) continue;

      const spineSlug = toGameSlug(pair.spineId, 'effect');
      const animSlug = toGameSlug(pair.animName, 'anim');
      const dedupeKey = `${spineSlug}/${animSlug}`;
      if (exportedEffectKeys.has(dedupeKey)) continue;
      exportedEffectKeys.add(dedupeKey);

      params.onStep?.(
        `${ninja.name || ninja.id} · efeito ${spineSlug}/${animSlug} (${i + 1}/${pairs.length})...`
      );

      const renderedEff = await renderSkeletonAnimationToPhaserFiles({
        characterIdSlug: spineSlug,
        skeleton: effAsset.skeleton,
        effectiveAnim: matchedAnim,
        originalAnim: pair.animName,
        animSlug,
        regionCanvasMap: effAsset.regionCanvasMap,
        fps,
        baseRelDir: `${charRoot}/effects/${spineSlug}`,
        events: { hits: [], particles: [], sounds: [], videos: [] },
        collectEmitterPoints: false,
        facing,
        includeGif: false,
        signal,
      });

      for (const f of renderedEff.files) pushFile(f.path, f.bytes);
      skippedWarnings.push(...renderedEff.warnings);

      manifestEffects.push({
        spineId: spineSlug,
        originalSpineId: pair.spineId,
        animSlug,
        originalAnim: pair.animName,
        jsonFile: renderedEff.jsonFile.slice(charRoot.length + 1),
        imageFiles: renderedEff.imageFiles.map((p) => p.slice(charRoot.length + 1)),
      });
    }
  }

  // 3. Collect ONLY MP3 sounds used by exported animations
  const manifestAudio: GameCharacterManifest['audio'] = [];
  if (options.includeAudio && uniqueSoundNames.size > 0) {
    const soundEntries = Array.from(uniqueSoundNames.entries());
    params.onStep?.(`${ninja.name || ninja.id} · coletando ${soundEntries.length} som(ns) MP3...`);
    for (let i = 0; i < soundEntries.length; i += 6) {
      throwIfAborted(signal);
      const batch = soundEntries.slice(i, i + 6);
      const fetched = await Promise.all(
        batch.map(async ([slug, origName]) => {
          const url = resolveMediaSoundUrl(origName, fullMediaProfile, ninja.atlasUrl);
          if (!url) return { slug, origName, bytes: null as Uint8Array | null, tooLarge: false };
          const res = await fetchBinaryCapped(url, MAX_GAME_FILE_BYTES, signal);
          return { slug, origName, bytes: res.bytes, tooLarge: Boolean(res.skippedTooLarge) };
        })
      );
      for (const item of fetched) {
        if (item.tooLarge) {
          skippedWarnings.push(`Áudio ${item.slug}.mp3 excede 20 MB e foi ignorado.`);
          continue;
        }
        if (!item.bytes) continue;
        const relFile = `audio/${item.slug}.mp3`;
        pushFile(`${charRoot}/${relFile}`, item.bytes);
        manifestAudio.push({
          name: item.slug,
          originalName: item.origName,
          file: relFile,
        });
      }
    }
  }

  // 4. Optional MP4 videos (OFF by default)
  const manifestVideos: NonNullable<GameCharacterManifest['videos']> = [];
  if (options.includeVideos && uniqueVideoRefs.size > 0) {
    const vidEntries = Array.from(uniqueVideoRefs.entries());
    params.onStep?.(`${ninja.name || ninja.id} · coletando ${vidEntries.length} vídeo(s) MP4...`);
    for (const [slug, vRef] of vidEntries) {
      throwIfAborted(signal);
      const url = resolveMediaVideoUrl(vRef, fullMediaProfile, ninja.atlasUrl);
      if (!url) continue;
      const res = await fetchBinaryCapped(url, MAX_GAME_FILE_BYTES, signal);
      if (res.skippedTooLarge) {
        skippedWarnings.push(`Vídeo ${slug}.mp4 excede 20 MB e foi ignorado.`);
        continue;
      }
      if (!res.bytes) continue;
      const relFile = `video/${slug}.mp4`;
      pushFile(`${charRoot}/${relFile}`, res.bytes);
      manifestVideos.push({
        name: slug,
        originalName: vRef.resolvedName,
        file: relFile,
      });
    }
  }

  // 5. Reuse combate_e_habilidades.json and animacoes_instrucoes.json from completeCharacterExporter.ts
  const combatJsonText =
    buildCharacterCombatJson(ninja.id, fullMediaProfile) ||
    JSON.stringify(
      {
        schemaVersion: 'shinobi-combat-v1',
        characterId: ninja.id,
        heroCode: ninja.code,
        displayName: ninja.name || ninja.id,
        skills: {},
        passives: [],
      },
      null,
      2
    );
  pushFile(`${charRoot}/combate_e_habilidades.json`, textEncoder.encode(combatJsonText));

  const instructionsJsonText = buildCharacterInstructionsJson(
    ninja.id,
    skeleton,
    options.includeEffects ? 'all' : 'base',
    effectBundles,
    missingEffects,
    fullMediaProfile
  );
  pushFile(`${charRoot}/animacoes_instrucoes.json`, textEncoder.encode(instructionsJsonText));

  // 6. Build character.json
  const charRelFiles = allFiles
    .map((f) => f.path.slice(charRoot.length + 1))
    .concat('character.json')
    .sort();

  const manifest: GameCharacterManifest = {
    schemaVersion: 'shinobi-phaser-v1',
    id: idSlug,
    originalId: ninja.id,
    code: ninja.code || fullMediaProfile?.heroCode || '',
    name: fullMediaProfile?.displayName || ninja.name || ninja.id,
    width: charWidth,
    height: charHeight,
    fps,
    facing,
    roles,
    roleToOriginalAnim,
    animations: manifestAnims,
    effects: manifestEffects,
    audio: manifestAudio,
    ...(manifestVideos.length > 0 ? { videos: manifestVideos } : {}),
    files: charRelFiles,
  };

  pushFile(`${charRoot}/character.json`, textEncoder.encode(JSON.stringify(manifest, null, 2)));

  const totalBytes = allFiles.reduce((sum, f) => sum + f.bytes.byteLength, 0);
  const indexEntry: GameIndexCharacterEntry = {
    id: idSlug,
    originalId: ninja.id,
    code: manifest.code,
    name: manifest.name,
    path: charRoot,
    characterJson: `${charRoot}/character.json`,
    width: charWidth,
    height: charHeight,
    fps,
    facing,
    roles,
    fileCount: allFiles.length,
    totalBytes,
    files: allFiles.map((f) => f.path).sort(),
  };

  return {
    characterIdSlug: idSlug,
    manifest,
    indexEntry,
    files: allFiles,
    skippedWarnings,
  };
}

export function mergeGameRootIndex(
  existing: GameRootIndex | null | undefined,
  newEntries: GameIndexCharacterEntry[]
): GameRootIndex {
  const byId = new Map<string, GameIndexCharacterEntry>();
  if (existing?.characters && Array.isArray(existing.characters)) {
    for (const c of existing.characters) {
      if (c && c.id) byId.set(c.id, c);
    }
  }
  for (const entry of newEntries) {
    byId.set(entry.id, entry);
  }
  const sorted = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 'shinobi-phaser-index-v1',
    generatedAt: new Date().toISOString(),
    totalCharacters: sorted.length,
    characters: sorted,
  };
}

/**
 * Fallback without GitHub token: splits all generated files into ZIP archives
 * of at most 20 MB each and downloads them cleanly.
 */
export async function downloadSplitGameExportZips(
  files: GameExportFile[],
  baseFilename = 'shinobi_phaser_assets',
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Array<{ filename: string; fileCount: number; bytes: number }>> {
  const parts: GameExportFile[][] = [];
  let currentPart: GameExportFile[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const overhead = file.bytes.byteLength + file.path.length * 2 + 128;
    if (currentPart.length > 0 && currentBytes + overhead > MAX_SPLIT_ZIP_PART_BYTES) {
      parts.push(currentPart);
      currentPart = [];
      currentBytes = 0;
    }
    currentPart.push(file);
    currentBytes += overhead;
  }
  if (currentPart.length > 0) {
    parts.push(currentPart);
  }

  const downloaded: Array<{ filename: string; fileCount: number; bytes: number }> = [];
  const safeBase = toGameSlug(baseFilename, 'shinobi_phaser_assets');

  for (let p = 0; p < parts.length; p++) {
    throwIfAborted(signal);
    const partFiles = parts[p];
    const filename =
      parts.length === 1
        ? `${safeBase}.zip`
        : `${safeBase}_parte_${String(p + 1).padStart(2, '0')}.zip`;

    onProgress?.(`Montando ${filename} (${partFiles.length} arquivos)...`);

    const entries: StreamingZipEntry[] = partFiles.map((f) => ({
      path: f.path,
      size: f.bytes.byteLength,
      crc32: computeCrc32(f.bytes),
      blob: new Blob([f.bytes as Uint8Array<ArrayBuffer>]),
    }));

    const zipBlob = await assembleStreamingZipBlob(
      async function* () {
        for (let i = 0; i < entries.length; i += 24) {
          yield entries.slice(i, i + 24);
        }
      },
      entries.length
    );

    downloadBlob(zipBlob, filename);
    downloaded.push({ filename, fileCount: partFiles.length, bytes: zipBlob.size });

    // Brief pause between multi-part browser downloads on Android Chrome
    if (p < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }

  return downloaded;
}
