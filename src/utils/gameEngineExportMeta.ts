import type {
  SpineAudioEventRef,
  SpineCommandEffectRef,
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
  hits: Array<{ timeMs: number; spineId: string; effectAnim: string }>;
  /** Self/aura/screen particle VFX triggered on character (ms) */
  particles: Array<{ timeMs: number; spineId: string; effectAnim: string; layer: 'behind' | 'front' }>;
  /** Audio SFX cue timestamps (ms) */
  sounds: Array<{ timeMs: number; soundName: string }>;
  /** Ultimate / cut-in video cue timestamps (ms) */
  videos: Array<{ timeMs: number; key: string }>;
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

export function buildAnimationEventsTimelineMs(
  effectRefs: SpineCommandEffectRef[],
  audioRefs: SpineAudioEventRef[],
  videoRefs: SpineVideoEventRef[]
): AnimationEventsTimelineMs {
  const hits: AnimationEventsTimelineMs['hits'] = [];
  const particles: AnimationEventsTimelineMs['particles'] = [];

  for (const ref of effectRefs) {
    const timeMs = Math.max(0, Math.round(ref.startTime * 1000));
    if (ref.isSelfOrScreen) {
      particles.push({
        timeMs,
        spineId: ref.spineId,
        effectAnim: ref.animName,
        layer: ref.layer,
      });
    } else {
      hits.push({
        timeMs,
        spineId: ref.spineId,
        effectAnim: ref.animName,
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
    .map((v) => ({
      timeMs: Math.max(0, Math.round(v.time * 1000)),
      key: v.resolvedName,
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

  hits.sort((a, b) => a.timeMs - b.timeMs);
  particles.sort((a, b) => a.timeMs - b.timeMs);

  return { hits, particles, sounds, videos };
}

/**
 * Generates a standard Phaser 3 / TexturePacker JSON Hash + Godot/Unity compatible
 * spritesheet metadata file (`<anim>_spritesheet.json`).
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
        [params.animName]: frameOrder,
      },
      meta: {
        app: 'Shinobi Sprite Studio',
        format: 'RGBA8888',
        image: params.imageFilename,
        size: { w: sheetW, h: sheetH },
        scale: '1',
        characterId: params.characterId,
        animation: params.animName,
        fps: params.fps,
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
      },
    },
    null,
    2
  );
}
