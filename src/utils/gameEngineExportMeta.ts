import type {
  AnimationImpactMetrics,
  EffectPlacementSpace,
  ScreenEffectFraming,
  SkeletonBlendSummary,
  SpineAudioEventRef,
  SpineBlendModeName,
  SpineCameraCue,
  SpineChoreographyCues,
  SpineCommandEffectRef,
  SpineHitEventRef,
  SpineMovementCue,
  SpinePhaseCue,
  SpineScreenCue,
  SpineVideoEventRef,
} from '../types/sprite';
import type { AnimationWorldBounds } from './atlasParser';

export interface GameEngineAnchorMetrics {
  /** Normalized X anchor (0..1, top-left origin: Phaser / Godot / TexturePacker) */
  anchorX: number;
  /** Normalized Y anchor (0..1, top-left origin: Phaser / Godot / TexturePacker) */
  anchorY: number;
  /** Normalized Y anchor (0..1, bottom-left origin: Unity Sprite Pivot) */
  anchorYBottom: number;
  /** Pixel X coordinate of the character feet origin (0,0) inside the cell */
  pivotPxX: number;
  /** Pixel Y coordinate of the character feet origin (0,0) inside the cell */
  pivotPxY: number;
  /** Scale factor applied from Spine world units to exported pixels */
  worldToPixelScale: number;
}

export interface AnimationEventsTimelineMs {
  /** Impact/hit VFX triggered on enemy target (ms) */
  hits: Array<{
    timeMs: number;
    spineId: string;
    effectAnim: string;
    targets?: string[];
    space?: EffectPlacementSpace;
    blendMode?: SpineBlendModeName;
    blendModes?: SpineBlendModeName[];
    usesAdditive?: boolean;
  }>;
  /** Self/aura/screen particle VFX triggered on character (ms) */
  particles: Array<{
    timeMs: number;
    spineId: string;
    effectAnim: string;
    layer: 'behind' | 'front';
    tela?: number;
    cena?: number;
    targets?: string[];
    space?: EffectPlacementSpace;
    blendMode?: SpineBlendModeName;
    blendModes?: SpineBlendModeName[];
    usesAdditive?: boolean;
    referenceViewport?: ScreenEffectFraming['referenceViewport'];
    focalBounds?: ScreenEffectFraming['focalBounds'];
  }>;
  /** Audio SFX cue timestamps (ms) */
  sounds: Array<{ timeMs: number; soundName: string }>;
  /** Ultimate / cut-in video cue timestamps (ms) */
  videos: Array<{
    timeMs: number;
    key: string;
    durationMs?: number;
    resumeAfterMs?: number;
  }>;
  /** Detailed per-hit damage distribution, hurt anim, knockback velocity & final flag */
  hitEvents?: Array<{
    timeMs: number;
    target?: string;
    damagePercent?: number;
    hurtAnim?: string;
    blowup?: number;
    velocity?: { x?: number; y?: number };
    final?: boolean;
  }>;
  /** Camera zoom/focus and screen-shake cues */
  cameraCues?: SpineCameraCue[];
  /** Screen flash, background swap, dim/tint, portrait cut-in cues */
  screenCues?: SpineScreenCue[];
  /** Character dash/teleport/sub-animation/target-attach cues */
  movementCues?: SpineMovementCue[];
  /** Combat timeline lifecycle markers (PREACT, NEXT, POSTACT, END, pause, label) */
  phaseCues?: SpinePhaseCue[];
}

/**
 * Computes the exact pixel and normalized feet pivot coordinates (Spine world 0,0)
 * inside an exported frame/spritesheet cell of size (cellW, cellH).
 */
export function computeAnimationAnchorMetrics(
  bounds: AnimationWorldBounds,
  cellW: number,
  cellH: number,
  fillRatio = 0.86,
  maxAutoFitScale = 4.0
): GameEngineAnchorMetrics {
  const safeW = Math.max(1, cellW);
  const safeH = Math.max(1, cellH);
  const fitScale = Math.min(
    (safeW * fillRatio) / Math.max(1, bounds.width),
    (safeH * fillRatio) / Math.max(1, bounds.height)
  );
  const scale = Math.min(maxAutoFitScale, Math.max(0.05, fitScale));
  const pivotPxX = safeW / 2 - bounds.centerX * scale;
  const pivotPxY = safeH / 2 + bounds.centerY * scale;
  const anchorX = pivotPxX / safeW;
  const anchorY = pivotPxY / safeH;

  return {
    anchorX: Number(anchorX.toFixed(5)),
    anchorY: Number(anchorY.toFixed(5)),
    anchorYBottom: Number((1 - anchorY).toFixed(5)),
    pivotPxX: Number(pivotPxX.toFixed(2)),
    pivotPxY: Number(pivotPxY.toFixed(2)),
    worldToPixelScale: Number(scale.toFixed(5)),
  };
}

export interface TimelineEnrichmentMeta {
  screenFramingByKey?: Map<string, ScreenEffectFraming>;
  videoSyncByKey?: Map<string, { durationMs?: number; resumeAfterMs?: number }>;
  effectBlendByKey?: Map<string, SkeletonBlendSummary>;
  hitRefs?: SpineHitEventRef[];
  choreography?: SpineChoreographyCues;
}

export function buildAnimationEventsTimelineMs(
  effectRefs: SpineCommandEffectRef[],
  audioRefs: SpineAudioEventRef[],
  videoRefs: SpineVideoEventRef[],
  meta?: TimelineEnrichmentMeta
): AnimationEventsTimelineMs {
  const hits: AnimationEventsTimelineMs['hits'] = [];
  const particles: AnimationEventsTimelineMs['particles'] = [];

  const lookupBlend = (spineId: string, animName: string): SkeletonBlendSummary | undefined => {
    const map = meta?.effectBlendByKey;
    if (!map) return undefined;
    return (
      map.get(`${spineId}::${animName}`) ||
      map.get(`${spineId}::${animName}`.toLowerCase()) ||
      map.get(spineId) ||
      map.get(spineId.toLowerCase())
    );
  };

  for (const ref of effectRefs) {
    const timeMs = Math.max(0, Math.round(ref.startTime * 1000));
    const blend = lookupBlend(ref.spineId, ref.animName);
    const blendMeta = blend
      ? {
          blendMode: blend.primaryBlendMode,
          blendModes: blend.blendModes,
          usesAdditive: blend.usesAdditive,
        }
      : {};
    const placementMeta = {
      ...(ref.targets && ref.targets.length > 0 ? { targets: ref.targets } : {}),
      ...(ref.space ? { space: ref.space } : {}),
    };

    if (ref.isSelfOrScreen) {
      const framingKey = `${ref.spineId}::${ref.animName}`.toLowerCase();
      const framing =
        meta?.screenFramingByKey?.get(`${ref.spineId}::${ref.animName}`) ||
        meta?.screenFramingByKey?.get(framingKey);
      const isTela5 = ref.tela === 5;
      particles.push({
        timeMs,
        spineId: ref.spineId,
        effectAnim: ref.animName,
        layer: ref.layer,
        ...(typeof ref.tela === 'number' ? { tela: ref.tela } : {}),
        ...(typeof ref.cena === 'number' ? { cena: ref.cena } : {}),
        ...placementMeta,
        ...blendMeta,
        ...(isTela5 && framing
          ? {
              referenceViewport: framing.referenceViewport,
              focalBounds: framing.focalBounds,
            }
          : {}),
      });
    } else {
      hits.push({
        timeMs,
        spineId: ref.spineId,
        effectAnim: ref.animName,
        ...placementMeta,
        ...blendMeta,
      });
    }
  }

  const sounds = audioRefs
    .map((s) => ({
      timeMs: Math.max(0, Math.round(s.time * 1000)),
      soundName: s.soundName,
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

  const videos = videoRefs
    .map((v) => {
      const sync =
        meta?.videoSyncByKey?.get(v.resolvedName) ||
        meta?.videoSyncByKey?.get(v.resolvedName.toLowerCase()) ||
        meta?.videoSyncByKey?.get(v.source) ||
        meta?.videoSyncByKey?.get(v.source.toLowerCase());
      return {
        timeMs: Math.max(0, Math.round(v.time * 1000)),
        key: v.resolvedName,
        ...(typeof sync?.durationMs === 'number' ? { durationMs: sync.durationMs } : {}),
        ...(typeof sync?.resumeAfterMs === 'number' ? { resumeAfterMs: sync.resumeAfterMs } : {}),
      };
    })
    .sort((a, b) => a.timeMs - b.timeMs);

  hits.sort((a, b) => a.timeMs - b.timeMs);
  particles.sort((a, b) => a.timeMs - b.timeMs);

  const hitEvents =
    meta?.hitRefs && meta.hitRefs.length > 0
      ? meta.hitRefs.map((h) => ({
          timeMs: Math.max(0, Math.round(h.time * 1000)),
          ...(h.target ? { target: h.target } : {}),
          ...(typeof h.p === 'number' ? { damagePercent: h.p } : {}),
          ...(h.hurtAnim ? { hurtAnim: h.hurtAnim } : {}),
          ...(typeof h.blowup === 'number' ? { blowup: h.blowup } : {}),
          ...(h.velocity ? { velocity: h.velocity } : {}),
          ...(h.final ? { final: true } : {}),
        }))
      : undefined;

  const choreo = meta?.choreography;

  return {
    hits,
    particles,
    sounds,
    videos,
    ...(hitEvents && hitEvents.length > 0 ? { hitEvents } : {}),
    ...(choreo?.cameraCues && choreo.cameraCues.length > 0 ? { cameraCues: choreo.cameraCues } : {}),
    ...(choreo?.screenCues && choreo.screenCues.length > 0 ? { screenCues: choreo.screenCues } : {}),
    ...(choreo?.movementCues && choreo.movementCues.length > 0
      ? { movementCues: choreo.movementCues }
      : {}),
    ...(choreo?.phaseCues && choreo.phaseCues.length > 0 ? { phaseCues: choreo.phaseCues } : {}),
  };
}

export interface FrameEmitterPoint {
  frame: number;
  timeMs: number;
  /** Pixel X relative to feet pivot (+X right) */
  x: number;
  /** Pixel Y relative to feet pivot (-Y up, +Y down) */
  y: number;
  bone: string;
  source: 'bone' | 'overlay' | 'bounds';
}

/**
 * Generates a standard Phaser 3 / TexturePacker JSON Hash + Godot/Unity compatible
 * spritesheet metadata file (`<anim>_spritesheet.json` or `<anim>.json`).
 */
export function buildGameEngineSpritesheetJson(params: {
  characterId: string;
  animName: string;
  safeAnimName: string;
  imageFilename: string;
  frameCount: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  fps: number;
  durationSec: number;
  anchor: GameEngineAnchorMetrics;
  events: AnimationEventsTimelineMs;
  impactMetrics?: AnimationImpactMetrics | null;
  emitterPoints?: FrameEmitterPoint[];
  emitterBone?: string | null;
  blendSummary?: SkeletonBlendSummary | null;
}): string {
  const sheetW = params.cols * params.cellW;
  const sheetH = params.rows * params.cellH;
  const frameDurationMs =
    params.frameCount > 0 && params.durationSec > 0
      ? Math.round((params.durationSec * 1000) / params.frameCount)
      : Math.round(1000 / Math.max(1, params.fps));

  const frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: boolean;
      trimmed: boolean;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
      pivot: { x: number; y: number };
      duration: number;
    }
  > = {};

  const frameOrder: string[] = [];
  for (let f = 0; f < params.frameCount; f++) {
    const col = f % params.cols;
    const row = Math.floor(f / params.cols);
    const key = `${params.safeAnimName}_${String(f).padStart(3, '0')}.png`;
    frameOrder.push(key);
    frames[key] = {
      frame: {
        x: col * params.cellW,
        y: row * params.cellH,
        w: params.cellW,
        h: params.cellH,
      },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: params.cellW, h: params.cellH },
      sourceSize: { w: params.cellW, h: params.cellH },
      pivot: { x: params.anchor.anchorX, y: params.anchor.anchorY },
      duration: frameDurationMs,
    };
  }

  return JSON.stringify(
    {
      frames,
      animations: {
        [params.safeAnimName]: frameOrder,
      },
      meta: {
        app: 'Shinobi Sprite Studio',
        format: 'RGBA8888',
        image: params.imageFilename,
        size: { w: sheetW, h: sheetH },
        scale: '1',
        characterId: params.characterId,
        animation: params.animName,
        slug: params.safeAnimName,
        fps: params.fps,
        frameDurationMs,
        durationMs: Math.round(params.durationSec * 1000),
        frameCount: params.frameCount,
        grid: {
          cols: params.cols,
          rows: params.rows,
          cellWidth: params.cellW,
          cellHeight: params.cellH,
        },
        anchor: {
          x: params.anchor.anchorX,
          y: params.anchor.anchorY,
          yBottomLeft: params.anchor.anchorYBottom,
          pivotPxX: params.anchor.pivotPxX,
          pivotPxY: params.anchor.pivotPxY,
          note: 'Coordenadas dos pes do ninja (origem Spine 0,0) na celula para alinhamento no chao em Phaser, Godot e Unity.',
        },
        eventsMs: params.events,
        ...(params.blendSummary
          ? {
              blendMode: params.blendSummary.primaryBlendMode,
              blendModes: params.blendSummary.blendModes,
              usesAdditive: params.blendSummary.usesAdditive,
            }
          : {}),
        ...(params.impactMetrics
          ? {
              impactMs: params.impactMetrics.impactMs,
              impactReachPx: params.impactMetrics.impactReachPx,
              impactCenterX: params.impactMetrics.impactCenterX,
            }
          : {}),
        ...(params.emitterPoints && params.emitterPoints.length > 0
          ? {
              emitterBone: params.emitterBone || params.emitterPoints[0]?.bone || undefined,
              emitterNote:
                'Posicao por frame da mao/arma/ponto de disparo em pixels relativos ao pivo dos pes (+x direita, -y acima dos pes).',
              emitterPoints: params.emitterPoints,
            }
          : {}),
      },
    },
    null,
    2
  );
}

export interface MultiAtlasPageSpec {
  imageFilename: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  frameIndices: number[];
}

/**
 * Generates a Phaser 3 MultiAtlas JSON (`this.load.multiatlas`) when a 1:1 spritesheet
 * is split across multiple <= 2048x2048 PNG pages.
 */
export function buildPhaserMultiAtlasJson(params: {
  characterId: string;
  animName: string;
  safeAnimName: string;
  pages: MultiAtlasPageSpec[];
  frameCount: number;
  cellW: number;
  cellH: number;
  fps: number;
  durationSec: number;
  anchor: GameEngineAnchorMetrics;
  events: AnimationEventsTimelineMs;
  impactMetrics?: AnimationImpactMetrics | null;
  emitterPoints?: FrameEmitterPoint[];
  emitterBone?: string | null;
  blendSummary?: SkeletonBlendSummary | null;
}): string {
  const frameDurationMs =
    params.frameCount > 0 && params.durationSec > 0
      ? Math.round((params.durationSec * 1000) / params.frameCount)
      : Math.round(1000 / Math.max(1, params.fps));

  const frameOrder: string[] = [];
  for (let f = 0; f < params.frameCount; f++) {
    frameOrder.push(`${params.safeAnimName}_${String(f).padStart(3, '0')}.png`);
  }

  const textures = params.pages.map((page) => ({
    image: page.imageFilename,
    format: 'RGBA8888',
    size: { w: page.width, h: page.height },
    scale: 1,
    frames: page.frameIndices.map((globalFrameIdx, localIdx) => {
      const col = localIdx % page.cols;
      const row = Math.floor(localIdx / page.cols);
      return {
        filename: `${params.safeAnimName}_${String(globalFrameIdx).padStart(3, '0')}.png`,
        rotated: false,
        trimmed: false,
        sourceSize: { w: params.cellW, h: params.cellH },
        spriteSourceSize: { x: 0, y: 0, w: params.cellW, h: params.cellH },
        frame: {
          x: col * params.cellW,
          y: row * params.cellH,
          w: params.cellW,
          h: params.cellH,
        },
        pivot: { x: params.anchor.anchorX, y: params.anchor.anchorY },
        duration: frameDurationMs,
      };
    }),
  }));

  return JSON.stringify(
    {
      textures,
      animations: {
        [params.safeAnimName]: frameOrder,
      },
      meta: {
        app: 'Shinobi Sprite Studio',
        format: 'RGBA8888',
        multiatlas: true,
        images: params.pages.map((p) => p.imageFilename),
        scale: '1',
        characterId: params.characterId,
        animation: params.animName,
        slug: params.safeAnimName,
        fps: params.fps,
        frameDurationMs,
        durationMs: Math.round(params.durationSec * 1000),
        frameCount: params.frameCount,
        cellWidth: params.cellW,
        cellHeight: params.cellH,
        anchor: {
          x: params.anchor.anchorX,
          y: params.anchor.anchorY,
          yBottomLeft: params.anchor.anchorYBottom,
          pivotPxX: params.anchor.pivotPxX,
          pivotPxY: params.anchor.pivotPxY,
          note: 'Coordenadas dos pes do ninja (origem Spine 0,0) na celula para alinhamento no chao em Phaser, Godot e Unity.',
        },
        eventsMs: params.events,
        ...(params.blendSummary
          ? {
              blendMode: params.blendSummary.primaryBlendMode,
              blendModes: params.blendSummary.blendModes,
              usesAdditive: params.blendSummary.usesAdditive,
            }
          : {}),
        ...(params.impactMetrics
          ? {
              impactMs: params.impactMetrics.impactMs,
              impactReachPx: params.impactMetrics.impactReachPx,
              impactCenterX: params.impactMetrics.impactCenterX,
            }
          : {}),
        ...(params.emitterPoints && params.emitterPoints.length > 0
          ? {
              emitterBone: params.emitterBone || params.emitterPoints[0]?.bone || undefined,
              emitterNote:
                'Posicao por frame da mao/arma/ponto de disparo em pixels relativos ao pivo dos pes (+x direita, -y acima dos pes).',
              emitterPoints: params.emitterPoints,
            }
          : {}),
      },
    },
    null,
    2
  );
}


