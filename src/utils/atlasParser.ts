import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type {
  AtlasPage,
  AtlasRegion,
  CompositeSpineLayer,
  SlicedFrame,
  SpineAnimationData,
  SpineAttachmentInfo,
  SpineAudioEventRef,
  SpineBoneDef,
  SpineCommandEffectRef,
  SpineShowFeatureRef,
  SpineSlotDef,
  SpineSkeleton,
  SpineVideoEventRef,
} from '../types/sprite';
import { createZipWorkerSession } from './zipWorkerClient';
import {
  assembleStreamingZipBlob,
  computeCrc32,
  type StreamingZipEntry,
} from './streamingZip';

export function parseAtlas(atlasText: string): AtlasPage[] {
  const lines = atlasText.split(/\r?\n/);
  const pages: AtlasPage[] = [];
  let currentPage: AtlasPage | null = null;
  let currentRegion: AtlasRegion | null = null;

  const parsePair = (val: string): [number, number] => {
    const parts = val.split(',').map((s) => Number(s.trim()));
    return [parts[0] || 0, parts[1] || 0];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (currentRegion && currentPage) {
        currentPage.regions.push(currentRegion);
        currentRegion = null;
      }
      currentPage = null;
      continue;
    }

    const isIndented = /^\s+/.test(rawLine);
    const colonIdx = trimmed.indexOf(':');

    if (!currentPage) {
      currentPage = {
        name: trimmed,
        width: 0,
        height: 0,
        regions: [],
      };
      pages.push(currentPage);
      continue;
    }

    if (!isIndented && colonIdx !== -1 && !currentRegion) {
      // Page header property
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'size') {
        const [w, h] = parsePair(val);
        currentPage.width = w;
        currentPage.height = h;
      } else if (key === 'format') {
        currentPage.format = val;
      } else if (key === 'filter') {
        currentPage.filter = val;
      } else if (key === 'repeat') {
        currentPage.repeat = val;
      }
      continue;
    }

    if (!isIndented && colonIdx === -1) {
      // Could be a new region name OR a new page name without blank line
      if (/\.(png|webp|jpe?g|gif|ktx2?)$/i.test(trimmed)) {
        if (currentRegion) {
          currentPage.regions.push(currentRegion);
          currentRegion = null;
        }
        currentPage = {
          name: trimmed,
          width: 0,
          height: 0,
          regions: [],
        };
        pages.push(currentPage);
      } else {
        if (currentRegion) {
          currentPage.regions.push(currentRegion);
        }
        currentRegion = {
          name: trimmed,
          pageName: currentPage.name,
          rotate: 0,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          origWidth: 0,
          origHeight: 0,
          offsetX: 0,
          offsetY: 0,
          index: -1,
        };
      }
      continue;
    }

    if (currentRegion && colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'rotate') {
        if (val === 'true') currentRegion.rotate = 90;
        else if (val === 'false') currentRegion.rotate = 0;
        else currentRegion.rotate = Number(val) || 0;
      } else if (key === 'xy') {
        const [x, y] = parsePair(val);
        currentRegion.x = x;
        currentRegion.y = y;
      } else if (key === 'size') {
        const [w, h] = parsePair(val);
        currentRegion.width = w;
        currentRegion.height = h;
      } else if (key === 'orig') {
        const [ow, oh] = parsePair(val);
        currentRegion.origWidth = ow;
        currentRegion.origHeight = oh;
      } else if (key === 'offset') {
        const [ox, oy] = parsePair(val);
        currentRegion.offsetX = ox;
        currentRegion.offsetY = oy;
      } else if (key === 'index') {
        currentRegion.index = Number(val);
      }
    }
  }

  if (currentRegion && currentPage) {
    currentPage.regions.push(currentRegion);
  }

  return pages;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar imagem: ${src}`));
    img.src = src;
  });
}

export function extractRegionToCanvas(
  region: AtlasRegion,
  pageImage: HTMLImageElement
): HTMLCanvasElement {
  const outW = Math.max(1, region.origWidth || region.width);
  const outH = Math.max(1, region.origHeight || region.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const isRotated90 = region.rotate === 90;
  const srcW = isRotated90 ? region.height : region.width;
  const srcH = isRotated90 ? region.width : region.height;

  const destX = region.offsetX || 0;
  const destY = Math.max(0, outH - (region.offsetY || 0) - region.height);

  ctx.save();
  if (isRotated90) {
    ctx.translate(destX, destY + region.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(
      pageImage,
      region.x,
      region.y,
      srcW,
      srcH,
      0,
      0,
      srcW,
      srcH
    );
  } else {
    ctx.drawImage(
      pageImage,
      region.x,
      region.y,
      srcW,
      srcH,
      destX,
      destY,
      region.width,
      region.height
    );
  }
  ctx.restore();
  return canvas;
}

export function sliceAtlasRegions(
  pages: AtlasPage[],
  pageImages: Record<string, HTMLImageElement>
): SlicedFrame[] {
  const frames: SlicedFrame[] = [];
  for (const page of pages) {
    const img = pageImages[page.name];
    if (!img) continue;
    for (let i = 0; i < page.regions.length; i++) {
      const region = page.regions[i];
      const canvas = extractRegionToCanvas(region, img);
      frames.push({
        id: `${page.name}::${region.name}::${region.index}::${i}`,
        name: region.index >= 0 ? `${region.name}_${region.index}` : region.name,
        width: canvas.width,
        height: canvas.height,
        sourceX: region.x,
        sourceY: region.y,
        sourceWidth: region.width,
        sourceHeight: region.height,
        rotate: region.rotate,
        dataUrl: canvas.toDataURL('image/png'),
      });
    }
  }
  // Sort natural order (a0, a1, a2, ..., a10)
  return frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function getDefaultSkinAttachments(
  skeleton: SpineSkeleton
): Record<string, Record<string, SpineAttachmentInfo>> {
  if (!skeleton.skins) return {};
  if (Array.isArray(skeleton.skins)) {
    const def = skeleton.skins.find((s) => s.name === 'default') || skeleton.skins[0];
    return def?.attachments || {};
  }
  return skeleton.skins.default || Object.values(skeleton.skins)[0] || {};
}

export function hasVisibleAnimationContent(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): boolean {
  if (!skeleton || !animName) return false;
  if ((skeleton.slots || []).some((s) => Boolean(s.attachment))) return true;
  const anim = skeleton.animations?.[animName];
  if (!anim?.slots) return false;
  return Object.values(anim.slots).some((slotAnim) =>
    (slotAnim.attachment || []).some((kf) => Boolean(kf.name))
  );
}

/**
 * Resolves wrapper animations (e.g. uniqueSkill, superUniqueSkill, chase1Action,
 * attackAction, skillAction) that have no slot attachments of their own and only
 * emit @CMD `{PLAY:name="..."}` redirects to the real Spine animation.
 */
export function resolveEffectiveAnimationName(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): string {
  if (!skeleton?.animations || !animName) return animName;
  let current: string = animName;
  const visited = new Set<string>();

  for (let depth = 0; depth < 3; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    if (hasVisibleAnimationContent(skeleton, current)) {
      return current;
    }

    const anim: SpineAnimationData | undefined = skeleton.animations[current];
    if (!anim?.events?.length) break;

    const candidates: string[] = [];
    for (const ev of anim.events) {
      if (!ev.string) continue;
      for (const m of ev.string.matchAll(/\{PLAY:([^}]+)\}/g)) {
        const nameMatch = m[1].match(/name\s*=\s*["']([^"']+)["']/);
        const target = nameMatch?.[1]?.trim();
        if (target && skeleton.animations[target] && !visited.has(target)) {
          candidates.push(target);
        }
      }
    }

    if (candidates.length === 0) break;
    const nonTeleport = candidates.filter((c) => !/shunyi|teleport|blink/i.test(c));
    const next =
      nonTeleport.length > 0
        ? nonTeleport[nonTeleport.length - 1]
        : candidates[candidates.length - 1];
    if (!next || next === current) break;
    current = next;
  }

  return current;
}

export function isWrapperAnimation(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): boolean {
  if (!skeleton || !animName) return false;
  return resolveEffectiveAnimationName(skeleton, animName) !== animName;
}

export function getAnimationDuration(skeleton: SpineSkeleton, animName: string): number {
  const anim = skeleton.animations?.[animName];
  if (!anim) return 0;
  let maxTime = 0;

  if (anim.slots) {
    for (const slotAnim of Object.values(anim.slots)) {
      for (const kf of slotAnim.attachment || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of slotAnim.color || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of slotAnim.twoColor || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
    }
  }

  if (anim.bones) {
    for (const boneAnim of Object.values(anim.bones)) {
      for (const kf of boneAnim.rotate || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of boneAnim.translate || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of boneAnim.scale || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
      for (const kf of boneAnim.shear || []) {
        if ((kf.time || 0) > maxTime) maxTime = kf.time || 0;
      }
    }
  }

  for (const ev of anim.events || []) {
    if ((ev.time || 0) > maxTime) maxTime = ev.time || 0;
  }

  // Add 1 frame hold so last keyframe is visible
  return maxTime > 0 ? maxTime + 1 / 24 : 0.5;
}

export function extractSpineEffectRefs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineCommandEffectRef[] {
  if (!skeleton || !animName) return [];
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const refs: SpineCommandEffectRef[] = [];
  const seen = new Set<string>();

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;

    for (const ev of anim.events) {
      if (!ev.string) continue;
      const cmdMatches = ev.string.matchAll(/\{([A-Za-z0-9_]+):([^}]+)\}/g);
      for (const m of cmdMatches) {
        const cmdType = m[1];
        const body = m[2];
        if (!cmdType.startsWith('DISPLAY')) continue;

        const spineMatch = body.match(/spine\s*=\s*["']([^"']+)["']/);
        const sourceMatch = body.match(/source\s*=\s*["']([^"']+)["']/);
        if (!spineMatch?.[1] || !sourceMatch?.[1]) continue;

        const layerMatch = body.match(/layer\s*=\s*["']([^"']+)["']/);
        const loopMatch = body.match(/loop\s*=\s*["']([^"']+)["']/);
        const hasSelfTarget = /targets\s*=\s*\[[^\]]*["']self["'][^\]]*\]/.test(body);

        const spineId = spineMatch[1].trim();
        const effectAnim = sourceMatch[1].trim();
        const layerVal = (layerMatch?.[1] || '').toLowerCase();
        const layer: 'behind' | 'front' =
          layerVal === 'rbg' || layerVal === 'bg' ? 'behind' : 'front';
        const loopVal = (loopMatch?.[1] || '').toLowerCase();
        const loop = loopVal === 'true' || loopVal === '1' || loopVal === 'loop';
        const isSelfOrScreen = cmdType === 'DISPLAY' || hasSelfTarget;
        const startTime = Math.max(0, ev.time || 0);

        const key = `${spineId}::${effectAnim}::${startTime.toFixed(4)}::${layer}`;
        if (seen.has(key)) continue;
        seen.add(key);

        refs.push({
          spineId,
          animName: effectAnim,
          startTime,
          layer,
          isSelfOrScreen,
          loop,
          rawCommand: m[0],
        });
      }
    }
  }

  return refs;
}

export function extractSpineAudioRefs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineAudioEventRef[] {
  if (!skeleton || !animName) return [];
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const refs: SpineAudioEventRef[] = [];
  const seen = new Set<string>();

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;

    for (const ev of anim.events) {
      const time = Math.max(0, ev.time || 0);

      // Format 1: @CMD {SOUND:name="nos_146_3"} (vdfno_* characters)
      if (ev.string) {
        for (const m of ev.string.matchAll(/\{SOUND:([^}]+)\}/gi)) {
          const body = m[1];
          const nameMatch =
            body.match(/name\s*=\s*["']([^"']+)["']/) ||
            body.match(/source\s*=\s*["']([^"']+)["']/);
          const soundName = nameMatch?.[1]?.trim();
          if (!soundName) continue;
          const key = `${soundName}::${time.toFixed(3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({ soundName, time, source: 'cmd' });
        }
      }

      // Format 2: Direct Spine event names (yy_*, atk_*, electric_*, etc. on Spine 3.8 characters)
      const rawName = (ev.name || '').trim();
      if (
        rawName &&
        rawName !== '@CMD' &&
        rawName.toLowerCase() !== 'label' &&
        !rawName.toLowerCase().startsWith('no:') &&
        !rawName.startsWith('{') &&
        /^[A-Za-z0-9_/-]+$/.test(rawName)
      ) {
        const key = `${rawName}::${time.toFixed(3)}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ soundName: rawName, time, source: 'event' });
        }
      }
    }
  }

  return refs.sort((a, b) => a.time - b.time);
}

export function extractSpineVideoRefs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineVideoEventRef[] {
  if (!skeleton || !animName) return [];
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const refs: SpineVideoEventRef[] = [];
  const seen = new Set<string>();

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;

    for (const ev of anim.events) {
      if (!ev.string) continue;
      for (const m of ev.string.matchAll(/\{PLAYV(?:E|I)D(?:E|I)O:([^}]+)\}/gi)) {
        const body = m[1] || '';
        const sourceMatch =
          body.match(/source\s*=\s*["']([^"']+)["']/i) ||
          body.match(/source\s*=\s*([A-Za-z0-9_.-]+)/i);
        const source = sourceMatch?.[1]?.trim();
        if (!source) continue;

        const careMatch = body.match(/careforward\s*=\s*["']?([^"',\s}]+)["']?/i);
        const careVal = (careMatch?.[1] || '').toLowerCase();
        const careforward = careVal === '1' || careVal === 'true';
        const layerMatch = body.match(/layer\s*=\s*["']([^"']+)["']/i);
        const layer = layerMatch?.[1]?.trim() || 'overlay';
        const resolvedName = careforward ? `${source}_left` : source;
        const time = Math.max(0, ev.time || 0);

        const key = `${resolvedName}::${time.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        refs.push({
          source,
          resolvedName,
          time,
          careforward,
          layer,
          rawCommand: m[0],
        });
      }
    }
  }

  return refs.sort((a, b) => a.time - b.time);
}

export function extractSpineShowFeatureRefs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineShowFeatureRef[] {
  if (!skeleton || !animName) return [];
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const refs: SpineShowFeatureRef[] = [];
  const seen = new Set<string>();

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;

    for (const ev of anim.events) {
      const str = ev.string;
      if (!str || !str.includes('SHOWFEATURE')) continue;

      let searchFrom = 0;
      while (searchFrom < str.length) {
        const startIdx = str.indexOf('{SHOWFEATURE:', searchFrom);
        if (startIdx === -1) break;

        // Match balanced braces because spine=[{file="...",anim="..."}, ...] contains nested {}
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < str.length; i++) {
          if (str[i] === '{') depth++;
          else if (str[i] === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (endIdx === -1) break;
        const rawCommand = str.slice(startIdx, endIdx + 1);
        searchFrom = endIdx + 1;

        const allFiles: string[] = [];
        let mainFile = '';
        for (const objMatch of rawCommand.matchAll(/\{([^{}]+)\}/g)) {
          const objBody = objMatch[1];
          const fileMatch = objBody.match(/file\s*=\s*["']([^"']+)["']/i);
          const f = fileMatch?.[1]?.trim();
          if (!f) continue;
          if (f.toLowerCase() !== 'tongyongtexie') {
            allFiles.push(f);
            if (/main\s*=\s*["']?1["']?/i.test(objBody) || !mainFile) {
              mainFile = f;
            }
          }
        }
        if (allFiles.length === 0) continue;

        const time = Math.max(0, ev.time || 0);
        const dedupeKey = `${mainFile}::${time.toFixed(3)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        refs.push({
          files: Array.from(new Set(allFiles)),
          mainFile: mainFile || allFiles[0],
          time,
          rawCommand,
        });
      }
    }
  }

  return refs.sort((a, b) => a.time - b.time);
}

export function getCompositeAnimationDuration(
  baseDuration: number,
  layers: CompositeSpineLayer[] = []
): number {
  let total = baseDuration;
  for (const layer of layers) {
    if (!layer.loop && layer.duration > 0) {
      const end = layer.startTime + Math.min(layer.duration, 8);
      if (end > total) total = end;
    }
  }
  return total;
}

function sampleLinear(
  frames: Array<{ time?: number; [key: string]: unknown }> | undefined,
  t: number,
  field: string,
  defaultVal: number
): number {
  if (!frames || frames.length === 0) return defaultVal;
  const firstTime = frames[0].time || 0;
  if (t <= firstTime) {
    const v = frames[0][field];
    return typeof v === 'number' ? v : defaultVal;
  }
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = a.time || 0;
    const tb = b.time || 0;
    if (t >= ta && t <= tb) {
      const va = typeof a[field] === 'number' ? (a[field] as number) : defaultVal;
      const vb = typeof b[field] === 'number' ? (b[field] as number) : defaultVal;
      if (a.curve === 'stepped' || tb === ta) return va;
      const alpha = (t - ta) / (tb - ta);
      return va + (vb - va) * alpha;
    }
  }
  const last = frames[frames.length - 1];
  const v = last[field];
  return typeof v === 'number' ? v : defaultVal;
}

function sampleAngle(
  frames: Array<{ time?: number; angle?: number; curve?: unknown }> | undefined,
  t: number
): number {
  if (!frames || frames.length === 0) return 0;
  const firstTime = frames[0].time || 0;
  if (t <= firstTime) return frames[0].angle || 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = a.time || 0;
    const tb = b.time || 0;
    if (t >= ta && t <= tb) {
      const va = a.angle || 0;
      const vb = b.angle || 0;
      if (a.curve === 'stepped' || tb === ta) return va;
      let diff = vb - va;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      const alpha = (t - ta) / (tb - ta);
      return va + diff * alpha;
    }
  }
  return frames[frames.length - 1].angle || 0;
}

interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

function mulMat(p: Mat2D, c: Mat2D): Mat2D {
  return {
    a: p.a * c.a + p.c * c.b,
    b: p.b * c.a + p.d * c.b,
    c: p.a * c.c + p.c * c.d,
    d: p.b * c.c + p.d * c.d,
    tx: p.a * c.tx + p.c * c.ty + p.tx,
    ty: p.b * c.tx + p.d * c.ty + p.ty,
  };
}

function makeLocalMat(
  x: number,
  y: number,
  rotDeg: number,
  sx: number,
  sy: number,
  shearX = 0,
  shearY = 0
): Mat2D {
  const radX = ((rotDeg + shearX) * Math.PI) / 180;
  const radY = ((rotDeg + 90 + shearY) * Math.PI) / 180;
  return {
    a: Math.cos(radX) * sx,
    b: Math.sin(radX) * sx,
    c: Math.cos(radY) * sy,
    d: Math.sin(radY) * sy,
    tx: x,
    ty: y,
  };
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHexRgba(colorHex?: string): RgbaColor {
  if (!colorHex || colorHex.length < 6) {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const r = parseInt(colorHex.slice(0, 2), 16);
  const g = parseInt(colorHex.slice(2, 4), 16);
  const b = parseInt(colorHex.slice(4, 6), 16);
  const aByte = colorHex.length >= 8 ? parseInt(colorHex.slice(6, 8), 16) : 255;
  return {
    r: Number.isNaN(r) ? 255 : Math.max(0, Math.min(255, r)),
    g: Number.isNaN(g) ? 255 : Math.max(0, Math.min(255, g)),
    b: Number.isNaN(b) ? 255 : Math.max(0, Math.min(255, b)),
    a: Number.isNaN(aByte) ? 1 : Math.max(0, Math.min(1, aByte / 255)),
  };
}

function sampleHexRgbaTimeline<T extends { time?: number; curve?: unknown }>(
  frames: T[] | undefined,
  getHex: (frame: T) => string | undefined,
  time: number
): RgbaColor | null {
  if (!frames || frames.length === 0) return null;

  const firstTime = frames[0].time || 0;
  if (time <= firstTime) return parseHexRgba(getHex(frames[0]));

  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const ta = a.time || 0;
    const tb = b.time || 0;
    if (time >= ta && time <= tb) {
      const ca = parseHexRgba(getHex(a));
      const cb = parseHexRgba(getHex(b));
      if (a.curve === 'stepped' || tb === ta) return ca;
      const alpha = (time - ta) / (tb - ta);
      return {
        r: Math.round(ca.r + (cb.r - ca.r) * alpha),
        g: Math.round(ca.g + (cb.g - ca.g) * alpha),
        b: Math.round(ca.b + (cb.b - ca.b) * alpha),
        a: ca.a + (cb.a - ca.a) * alpha,
      };
    }
  }
  return parseHexRgba(getHex(frames[frames.length - 1]));
}

function sampleSlotColor(
  slot: SpineSlotDef,
  anim: SpineAnimationData | undefined,
  time: number
): RgbaColor {
  const baseColor = parseHexRgba(slot.color);
  const slotAnim = anim?.slots?.[slot.name];
  const colorSample = sampleHexRgbaTimeline(slotAnim?.color, (f) => f.color, time);
  if (colorSample !== null) return colorSample;
  const twoColorSample = sampleHexRgbaTimeline(slotAnim?.twoColor, (f) => f.light, time);
  if (twoColorSample !== null) return twoColorSample;
  return baseColor;
}

function sampleSlotAlpha(
  slot: SpineSlotDef,
  anim: SpineAnimationData | undefined,
  time: number
): number {
  return sampleSlotColor(slot, anim, time).a;
}

let tintScratchCanvas: HTMLCanvasElement | null = null;
function getTintedSpriteCanvas(
  spriteCanvas: HTMLCanvasElement,
  r: number,
  g: number,
  b: number
): HTMLCanvasElement {
  if (!tintScratchCanvas && typeof document !== 'undefined') {
    tintScratchCanvas = document.createElement('canvas');
  }
  if (!tintScratchCanvas) return spriteCanvas;
  const w = Math.max(1, spriteCanvas.width);
  const h = Math.max(1, spriteCanvas.height);
  if (tintScratchCanvas.width !== w) tintScratchCanvas.width = w;
  if (tintScratchCanvas.height !== h) tintScratchCanvas.height = h;
  const tctx = tintScratchCanvas.getContext('2d');
  if (!tctx) return spriteCanvas;

  tctx.globalCompositeOperation = 'source-over';
  tctx.clearRect(0, 0, w, h);
  tctx.drawImage(spriteCanvas, 0, 0);
  // Multiply RGB color while preserving the sprite's exact alpha channel
  tctx.globalCompositeOperation = 'multiply';
  tctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tctx.fillRect(0, 0, w, h);
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(spriteCanvas, 0, 0);
  tctx.globalCompositeOperation = 'source-over';
  return tintScratchCanvas;
}

export interface AnimationWorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

function buildBoneMap(skeleton: SpineSkeleton): Map<string, SpineBoneDef> {
  const boneMap = new Map<string, SpineBoneDef>();
  for (const b of skeleton.bones || []) boneMap.set(b.name, b);
  return boneMap;
}

function resolveSlotAttachmentAtTime(
  slotName: string,
  defaultAttachment: string | undefined,
  anim: SpineAnimationData | undefined,
  time: number
): string | null | undefined {
  let attachmentName: string | null | undefined = defaultAttachment;
  const slotTimeline = anim?.slots?.[slotName]?.attachment;
  if (slotTimeline && slotTimeline.length > 0) {
    for (let i = 0; i < slotTimeline.length; i++) {
      if ((slotTimeline[i].time || 0) <= time + 1e-5) {
        attachmentName = slotTimeline[i].name ?? null;
      } else {
        break;
      }
    }
  }
  return attachmentName;
}

function createWorldMatrixResolver(
  boneMap: Map<string, SpineBoneDef>,
  anim: SpineAnimationData | undefined,
  time: number
) {
  const worldMatrices = new Map<string, Mat2D>();
  const getWorldMatrix = (boneName: string): Mat2D => {
    const cached = worldMatrices.get(boneName);
    if (cached) return cached;
    const def = boneMap.get(boneName);
    if (!def) {
      const idMat: Mat2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      worldMatrices.set(boneName, idMat);
      return idMat;
    }

    const boneAnim = anim?.bones?.[boneName];
    const lx = (def.x || 0) + sampleLinear(boneAnim?.translate, time, 'x', 0);
    const ly = (def.y || 0) + sampleLinear(boneAnim?.translate, time, 'y', 0);
    const lrot = (def.rotation || 0) + sampleAngle(boneAnim?.rotate, time);
    const lsx = (def.scaleX ?? 1) * sampleLinear(boneAnim?.scale, time, 'x', 1);
    const lsy = (def.scaleY ?? 1) * sampleLinear(boneAnim?.scale, time, 'y', 1);
    const lshx = (def.shearX || 0) + sampleLinear(boneAnim?.shear, time, 'x', 0);
    const lshy = (def.shearY || 0) + sampleLinear(boneAnim?.shear, time, 'y', 0);

    const local = makeLocalMat(lx, ly, lrot, lsx, lsy, lshx, lshy);
    const world = def.parent ? mulMat(getWorldMatrix(def.parent), local) : local;
    worldMatrices.set(boneName, world);
    return world;
  };
  return getWorldMatrix;
}

function collectSampleTimes(
  anim: SpineAnimationData | undefined,
  duration: number,
  samples: number
): number[] {
  const times = new Set<number>();
  const stepCount = Math.max(2, samples);
  for (let s = 0; s < stepCount; s++) {
    times.add(stepCount === 1 ? 0 : (s / (stepCount - 1)) * duration);
  }
  if (anim?.slots) {
    for (const slotAnim of Object.values(anim.slots)) {
      for (const kf of slotAnim.attachment || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
    }
  }
  if (anim?.bones) {
    for (const boneAnim of Object.values(anim.bones)) {
      for (const kf of boneAnim.translate || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
      for (const kf of boneAnim.rotate || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
      for (const kf of boneAnim.scale || []) {
        if (typeof kf.time === 'number') times.add(kf.time);
      }
    }
  }
  return Array.from(times).sort((a, b) => a - b);
}

function accumulateSkeletonBoundsAtTime(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  t: number,
  boundsAcc: { minX: number; maxX: number; minY: number; maxY: number },
  filterOpts?: {
    maxSlotSpan?: number;
    anchorCenterX?: number;
    anchorCenterY?: number;
    maxAnchorDist?: number;
  }
) {
  const anim = skeleton.animations?.[animName];
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);
  const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, t);

  for (const slot of slotsDef) {
    const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, t);
    if (!attachmentName) continue;
    if (sampleSlotAlpha(slot, anim, t) <= 0.01) continue;

    const attInfo = skinAttachments[slot.name]?.[attachmentName];
    const regionKey = attInfo?.path || attInfo?.name || attachmentName;
    const spriteCanvas = regionCanvasMap.get(regionKey);
    if (!spriteCanvas) continue;

    const wm = getWorldMatrix(slot.bone);
    const localMat = makeLocalMat(
      attInfo?.x || 0,
      attInfo?.y || 0,
      attInfo?.rotation || 0,
      attInfo?.scaleX ?? 1,
      attInfo?.scaleY ?? 1
    );
    const finalMat = mulMat(wm, localMat);

    const hw = (attInfo?.width || spriteCanvas.width) / 2;
    const hh = (attInfo?.height || spriteCanvas.height) / 2;

    const corners: Array<[number, number]> = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    let qMinX = Infinity;
    let qMaxX = -Infinity;
    let qMinY = Infinity;
    let qMaxY = -Infinity;
    for (const [cx, cy] of corners) {
      const wx = finalMat.a * cx + finalMat.c * cy + finalMat.tx;
      const wy = finalMat.b * cx + finalMat.d * cy + finalMat.ty;
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        qMinX = Infinity;
        break;
      }
      if (wx < qMinX) qMinX = wx;
      if (wx > qMaxX) qMaxX = wx;
      if (wy < qMinY) qMinY = wy;
      if (wy > qMaxY) qMaxY = wy;
    }
    if (!Number.isFinite(qMinX)) continue;

    if (filterOpts?.maxSlotSpan) {
      const qw = qMaxX - qMinX;
      const qh = qMaxY - qMinY;
      if (qw > filterOpts.maxSlotSpan || qh > filterOpts.maxSlotSpan) {
        continue;
      }
    }
    if (
      typeof filterOpts?.anchorCenterX === 'number' &&
      typeof filterOpts?.anchorCenterY === 'number' &&
      typeof filterOpts?.maxAnchorDist === 'number'
    ) {
      const qcx = (qMinX + qMaxX) / 2;
      const qcy = (qMinY + qMaxY) / 2;
      if (
        Math.abs(qcx - filterOpts.anchorCenterX) > filterOpts.maxAnchorDist ||
        Math.abs(qcy - filterOpts.anchorCenterY) > filterOpts.maxAnchorDist
      ) {
        continue;
      }
    }

    if (qMinX < boundsAcc.minX) boundsAcc.minX = qMinX;
    if (qMaxX > boundsAcc.maxX) boundsAcc.maxX = qMaxX;
    if (qMinY < boundsAcc.minY) boundsAcc.minY = qMinY;
    if (qMaxY > boundsAcc.maxY) boundsAcc.maxY = qMaxY;
  }
}

export function computeAnimationWorldBounds(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  samples = 24
): AnimationWorldBounds {
  return computeCompositeAnimationWorldBounds(skeleton, animName, regionCanvasMap, [], samples);
}

export function computeCompositeAnimationWorldBounds(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  compositeLayers: CompositeSpineLayer[] = [],
  samples = 24
): AnimationWorldBounds {
  const anim = skeleton.animations?.[animName];
  const baseDuration = getAnimationDuration(skeleton, animName);
  const baseAcc = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };

  const sampleTimes = collectSampleTimes(anim, baseDuration, samples);
  for (const t of sampleTimes) {
    accumulateSkeletonBoundsAtTime(skeleton, animName, regionCanvasMap, t, baseAcc, {
      maxSlotSpan: 2400,
    });
  }

  // Fallback without slot-span filter if all slots in a standalone effect were huge
  if (!Number.isFinite(baseAcc.minX) || !Number.isFinite(baseAcc.minY)) {
    for (const t of sampleTimes) {
      accumulateSkeletonBoundsAtTime(skeleton, animName, regionCanvasMap, t, baseAcc);
    }
  }

  const hasBaseBounds = Number.isFinite(baseAcc.minX) && Number.isFinite(baseAcc.minY);
  const baseW = hasBaseBounds ? Math.max(40, baseAcc.maxX - baseAcc.minX) : 160;
  const baseH = hasBaseBounds ? Math.max(40, baseAcc.maxY - baseAcc.minY) : 160;
  const baseCenterX = hasBaseBounds ? (baseAcc.minX + baseAcc.maxX) / 2 : 0;
  const baseCenterY = hasBaseBounds ? (baseAcc.minY + baseAcc.maxY) / 2 : 80;

  const boundsAcc = { ...baseAcc };

  if (compositeLayers.length > 0) {
    const effectAcc = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };
    const maxSlotSpan = hasBaseBounds ? Math.max(1500, Math.max(baseW, baseH) * 8) : 2400;
    const maxAnchorDist = hasBaseBounds ? Math.max(1600, Math.max(baseW, baseH) * 9) : undefined;

    for (const layer of compositeLayers) {
      const layerAnim = layer.skeleton.animations?.[layer.animName];
      const layerSampleTimes = collectSampleTimes(layerAnim, layer.duration, Math.min(samples, 16));
      for (const lt of layerSampleTimes) {
        accumulateSkeletonBoundsAtTime(
          layer.skeleton,
          layer.animName,
          layer.regionCanvasMap,
          lt,
          effectAcc,
          {
            maxSlotSpan,
            anchorCenterX: hasBaseBounds ? baseCenterX : undefined,
            anchorCenterY: hasBaseBounds ? baseCenterY : undefined,
            maxAnchorDist,
          }
        );
      }
    }

    if (Number.isFinite(effectAcc.minX) && Number.isFinite(effectAcc.minY)) {
      if (hasBaseBounds) {
        // Clamp extreme fullscreen particle layers while preserving large chase/Susano'o effects
        const padLeft = Math.max(680, baseW * 3.4);
        const padRight = Math.max(680, baseW * 3.4);
        const padBottom = Math.max(460, baseH * 2.2);
        const padTop = Math.max(680, baseH * 3.4);
        boundsAcc.minX = Math.min(boundsAcc.minX, Math.max(effectAcc.minX, baseAcc.minX - padLeft));
        boundsAcc.maxX = Math.max(boundsAcc.maxX, Math.min(effectAcc.maxX, baseAcc.maxX + padRight));
        boundsAcc.minY = Math.min(boundsAcc.minY, Math.max(effectAcc.minY, baseAcc.minY - padBottom));
        boundsAcc.maxY = Math.max(boundsAcc.maxY, Math.min(effectAcc.maxY, baseAcc.maxY + padTop));
      } else {
        boundsAcc.minX = effectAcc.minX;
        boundsAcc.maxX = effectAcc.maxX;
        boundsAcc.minY = effectAcc.minY;
        boundsAcc.maxY = effectAcc.maxY;
      }
    }
  }

  if (!Number.isFinite(boundsAcc.minX) || !Number.isFinite(boundsAcc.minY)) {
    const skelW = Math.max(80, skeleton.skeleton?.width || 160);
    const skelH = Math.max(80, skeleton.skeleton?.height || 160);
    return {
      minX: -skelW / 2,
      maxX: skelW / 2,
      minY: 0,
      maxY: skelH,
      width: skelW,
      height: skelH,
      centerX: 0,
      centerY: skelH / 2,
    };
  }

  const width = Math.max(16, boundsAcc.maxX - boundsAcc.minX);
  const height = Math.max(16, boundsAcc.maxY - boundsAcc.minY);
  return {
    minX: boundsAcc.minX,
    maxX: boundsAcc.maxX,
    minY: boundsAcc.minY,
    maxY: boundsAcc.maxY,
    width,
    height,
    centerX: (boundsAcc.minX + boundsAcc.maxX) / 2,
    centerY: (boundsAcc.minY + boundsAcc.maxY) / 2,
  };
}

function drawSkeletonAtTime(
  ctx: CanvasRenderingContext2D,
  skeleton: SpineSkeleton,
  animName: string,
  time: number,
  regionCanvasMap: Map<string, HTMLCanvasElement>
): number {
  const anim = skeleton.animations?.[animName];
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);
  const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, time);

  let drawnSlots = 0;

  for (const slot of slotsDef) {
    const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, time);
    if (!attachmentName) continue;

    const slotColor = sampleSlotColor(slot, anim, time);
    if (slotColor.a <= 0.004) continue;

    const attInfo = skinAttachments[slot.name]?.[attachmentName];
    const regionKey = attInfo?.path || attInfo?.name || attachmentName;
    const spriteCanvas = regionCanvasMap.get(regionKey);
    if (!spriteCanvas) continue;

    const needsTint = slotColor.r < 248 || slotColor.g < 248 || slotColor.b < 248;
    const drawSource = needsTint
      ? getTintedSpriteCanvas(spriteCanvas, slotColor.r, slotColor.g, slotColor.b)
      : spriteCanvas;

    const wm = getWorldMatrix(slot.bone);
    ctx.save();
    ctx.transform(wm.a, wm.b, wm.c, wm.d, wm.tx, wm.ty);

    if (slot.blend === 'additive') {
      ctx.globalCompositeOperation = 'lighter';
    } else if (slot.blend === 'multiply') {
      ctx.globalCompositeOperation = 'multiply';
    } else if (slot.blend === 'screen') {
      ctx.globalCompositeOperation = 'screen';
    }
    if (slotColor.a < 0.996) {
      ctx.globalAlpha *= slotColor.a;
    }

    const ax = attInfo?.x || 0;
    const ay = attInfo?.y || 0;
    const arot = ((attInfo?.rotation || 0) * Math.PI) / 180;
    const asx = attInfo?.scaleX ?? 1;
    const asy = attInfo?.scaleY ?? 1;
    const aw = attInfo?.width || spriteCanvas.width;
    const ah = attInfo?.height || spriteCanvas.height;

    ctx.translate(ax, ay);
    if (arot !== 0) ctx.rotate(arot);
    // Negate Y scale to draw upright canvas image inside Spine Y-up space
    ctx.scale(asx, -asy);
    ctx.drawImage(drawSource, -aw / 2, -ah / 2, aw, ah);

    ctx.restore();
    drawnSlots++;
  }

  return drawnSlots;
}

export interface RenderSpineFrameOptions {
  fillRatio?: number;
  maxAutoFitScale?: number;
  followFramePose?: boolean;
}

export function renderSpineFrameToCanvas(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  skeleton: SpineSkeleton,
  animName: string,
  time: number,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  zoom = 1,
  panX = 0,
  panY = 0,
  autoFitBounds?: AnimationWorldBounds | null,
  compositeLayers: CompositeSpineLayer[] = [],
  options?: RenderSpineFrameOptions
): number {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const fillRatio = options?.fillRatio ?? 0.86;
  const maxAutoFitScale = options?.maxAutoFitScale ?? 4.0;

  let effectiveScale: number;
  let anchorX: number;
  let anchorY: number;

  if (autoFitBounds) {
    const fitScale = Math.min(
      (canvasWidth * fillRatio) / autoFitBounds.width,
      (canvasHeight * fillRatio) / autoFitBounds.height
    );
    const baseScale = Math.min(maxAutoFitScale, Math.max(0.05, fitScale));
    effectiveScale = baseScale * zoom;

    let targetCenterX = autoFitBounds.centerX;
    let targetCenterY = autoFitBounds.centerY;

    if (options?.followFramePose && zoom > 1.0) {
      const frameAcc = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      };
      accumulateSkeletonBoundsAtTime(skeleton, animName, regionCanvasMap, time, frameAcc, {
        maxSlotSpan: 1200,
      });
      if (!Number.isFinite(frameAcc.minX) || !Number.isFinite(frameAcc.minY)) {
        accumulateSkeletonBoundsAtTime(skeleton, animName, regionCanvasMap, time, frameAcc, {
          maxSlotSpan: 2400,
        });
      }
      if (
        (!Number.isFinite(frameAcc.minX) || !Number.isFinite(frameAcc.minY)) &&
        compositeLayers.length > 0
      ) {
        for (const layer of compositeLayers) {
          if (time < layer.startTime) continue;
          const elapsed = time - layer.startTime;
          if (!layer.loop && elapsed > layer.duration) continue;
          const localT =
            layer.loop && layer.duration > 0 ? elapsed % layer.duration : elapsed;
          accumulateSkeletonBoundsAtTime(
            layer.skeleton,
            layer.animName,
            layer.regionCanvasMap,
            localT,
            frameAcc,
            { maxSlotSpan: 1800 }
          );
        }
      }
      if (Number.isFinite(frameAcc.minX) && Number.isFinite(frameAcc.minY)) {
        const frameCx = (frameAcc.minX + frameAcc.maxX) / 2;
        const frameCy = (frameAcc.minY + frameAcc.maxY) / 2;
        const blend = Math.min(1, (zoom - 1.0) / 0.35);
        targetCenterX = autoFitBounds.centerX + (frameCx - autoFitBounds.centerX) * blend;
        targetCenterY = autoFitBounds.centerY + (frameCy - autoFitBounds.centerY) * blend;
      }
    }

    anchorX = canvasWidth / 2 - targetCenterX * effectiveScale + panX;
    anchorY = canvasHeight / 2 + targetCenterY * effectiveScale + panY;
  } else {
    const skelBounds = skeleton.skeleton || {};
    const skelW = Math.max(80, skelBounds.width || 160);
    const skelH = Math.max(80, skelBounds.height || 160);
    const baseScale = Math.min((canvasWidth * 0.72) / skelW, (canvasHeight * 0.72) / skelH);
    effectiveScale = Math.min(maxAutoFitScale, Math.max(0.15, baseScale)) * zoom;
    anchorX = canvasWidth / 2 + panX;
    anchorY = canvasHeight * 0.76 + panY;
  }

  let drawnSlots = 0;

  ctx.save();
  // Spine Y-up coordinate space anchored near bottom-center
  ctx.translate(anchorX, anchorY);
  ctx.scale(effectiveScale, -effectiveScale);

  const renderLayer = (layer: CompositeSpineLayer) => {
    if (time < layer.startTime) return;
    const elapsed = time - layer.startTime;
    if (!layer.loop && elapsed > layer.duration) return;
    const localT =
      layer.loop && layer.duration > 0 ? elapsed % layer.duration : elapsed;
    drawnSlots += drawSkeletonAtTime(
      ctx,
      layer.skeleton,
      layer.animName,
      localT,
      layer.regionCanvasMap
    );
  };

  for (const layer of compositeLayers) {
    if (layer.layer === 'behind') renderLayer(layer);
  }

  drawnSlots += drawSkeletonAtTime(ctx, skeleton, animName, time, regionCanvasMap);

  for (const layer of compositeLayers) {
    if (layer.layer === 'front') renderLayer(layer);
  }

  ctx.restore();
  return drawnSlots;
}

export function sliceImageByGrid(
  img: HTMLImageElement,
  cols: number,
  rows: number,
  margin = 0,
  spacing = 0
): SlicedFrame[] {
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const usableW = img.width - margin * 2 - spacing * (safeCols - 1);
  const usableH = img.height - margin * 2 - spacing * (safeRows - 1);
  const cellW = Math.floor(usableW / safeCols);
  const cellH = Math.floor(usableH / safeRows);
  if (cellW <= 0 || cellH <= 0) return [];

  const frames: SlicedFrame[] = [];
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = cellW;
  tempCanvas.height = cellH;
  const ctx = tempCanvas.getContext('2d');
  if (!ctx) return [];

  let index = 0;
  for (let r = 0; r < safeRows; r++) {
    for (let c = 0; c < safeCols; c++) {
      const sx = margin + c * (cellW + spacing);
      const sy = margin + r * (cellH + spacing);
      ctx.clearRect(0, 0, cellW, cellH);
      ctx.drawImage(img, sx, sy, cellW, cellH, 0, 0, cellW, cellH);

      // Skip completely empty transparent cells
      const data = ctx.getImageData(0, 0, cellW, cellH).data;
      let hasPixels = false;
      for (let p = 3; p < data.length; p += 4) {
        if (data[p] > 4) {
          hasPixels = true;
          break;
        }
      }
      if (!hasPixels) continue;

      frames.push({
        id: `grid_${r}_${c}`,
        name: `sprite_${String(index).padStart(3, '0')}`,
        width: cellW,
        height: cellH,
        sourceX: sx,
        sourceY: sy,
        sourceWidth: cellW,
        sourceHeight: cellH,
        rotate: 0,
        dataUrl: tempCanvas.toDataURL('image/png'),
      });
      index++;
    }
  }

  return frames;
}

export function sliceImageByAutoBBox(
  img: HTMLImageElement,
  alphaThreshold = 12,
  minSize = 8,
  mergeGap = 2
): SlicedFrame[] {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.width;
  srcCanvas.height = img.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return [];
  srcCtx.drawImage(img, 0, 0);

  const w = img.width;
  const h = img.height;
  const imgData = srcCtx.getImageData(0, 0, w, h).data;
  const visited = new Uint8Array(w * h);

  interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  const boxes: Box[] = [];
  const queue = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx]) continue;
      if (imgData[idx * 4 + 3] <= alphaThreshold) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = idx;
      visited[idx] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const rMin = Math.max(0, cy - mergeGap - 1);
        const rMax = Math.min(h - 1, cy + mergeGap + 1);
        const cMin = Math.max(0, cx - mergeGap - 1);
        const cMax = Math.min(w - 1, cx + mergeGap + 1);

        for (let ny = rMin; ny <= rMax; ny++) {
          for (let nx = cMin; nx <= cMax; nx++) {
            const nIdx = ny * w + nx;
            if (!visited[nIdx] && imgData[nIdx * 4 + 3] > alphaThreshold) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw >= minSize && bh >= minSize) {
        boxes.push({ minX, minY, maxX, maxY });
      }
    }
  }

  // Sort reading order (rows, then left-to-right)
  boxes.sort((a, b) => {
    if (Math.abs(a.minY - b.minY) > 16) return a.minY - b.minY;
    return a.minX - b.minX;
  });

  const frames: SlicedFrame[] = [];
  const outCanvas = document.createElement('canvas');
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return [];

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    outCanvas.width = bw;
    outCanvas.height = bh;
    outCtx.clearRect(0, 0, bw, bh);
    outCtx.drawImage(img, b.minX, b.minY, bw, bh, 0, 0, bw, bh);
    frames.push({
      id: `bbox_${i}`,
      name: `sprite_${String(i).padStart(3, '0')}`,
      width: bw,
      height: bh,
      sourceX: b.minX,
      sourceY: b.minY,
      sourceWidth: bw,
      sourceHeight: bh,
      rotate: 0,
      dataUrl: outCanvas.toDataURL('image/png'),
    });
  }

  return frames;
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(',')[1];
  if (!base64) return null;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function exportFramesAsZip(
  zipFilename: string,
  frames: SlicedFrame[],
  extras?: {
    atlasText?: string;
    atlasName?: string;
    skeletonJson?: unknown;
    skeletonName?: string;
    extraFiles?: Array<{ path: string; data: Uint8Array | string }>;
  }
) {
  const session = createZipWorkerSession();
  try {
    const batch: Array<{ path: string; data: Uint8Array | string }> = [];
    for (const f of frames) {
      const bytes = dataUrlToUint8Array(f.dataUrl);
      if (bytes) {
        batch.push({ path: `frames/${f.name}.png`, data: bytes });
      }
    }
    if (extras?.atlasText && extras.atlasName) {
      batch.push({ path: extras.atlasName, data: extras.atlasText });
    }
    if (extras?.skeletonJson && extras.skeletonName) {
      batch.push({
        path: extras.skeletonName,
        data: JSON.stringify(extras.skeletonJson, null, 2),
      });
    }
    if (extras?.extraFiles?.length) {
      for (const extra of extras.extraFiles) {
        batch.push(extra);
      }
    }
    await session.addFilesBatch(batch);
    const blob = await session.generateBlob(undefined, 'STORE');
    downloadBlob(blob, zipFilename);
  } finally {
    session.dispose();
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

export async function extractRegionToPngBlob(
  region: AtlasRegion,
  pageImage: HTMLImageElement
): Promise<Blob | null> {
  const outW = Math.max(1, region.origWidth || region.width);
  const outH = Math.max(1, region.origHeight || region.height);
  const isRotated90 = region.rotate === 90;
  const srcW = isRotated90 ? region.height : region.width;
  const srcH = isRotated90 ? region.width : region.height;
  const destX = region.offsetX || 0;
  const destY = Math.max(0, outH - (region.offsetY || 0) - region.height);

  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(outW, outH);
    const ctx = off.getContext('2d');
    if (ctx) {
      ctx.save();
      if (isRotated90) {
        ctx.translate(destX, destY + region.height);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(pageImage, region.x, region.y, srcW, srcH, 0, 0, srcW, srcH);
      } else {
        ctx.drawImage(
          pageImage,
          region.x,
          region.y,
          srcW,
          srcH,
          destX,
          destY,
          region.width,
          region.height
        );
      }
      ctx.restore();
      return await off.convertToBlob({ type: 'image/png' });
    }
  }

  const canvas = extractRegionToCanvas(region, pageImage);
  return await canvasToPngBlob(canvas);
}

export function computeNativeExportCellSize(
  bounds: AnimationWorldBounds,
  maxDim = 2048
): { width: number; height: number } {
  let w = Math.max(160, Math.ceil(bounds.width * 1.16));
  let h = Math.max(160, Math.ceil(bounds.height * 1.16));
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.max(160, Math.floor(w * ratio));
    h = Math.max(160, Math.floor(h * ratio));
  }
  return { width: w, height: h };
}

function computeStripLayout(
  bounds: AnimationWorldBounds,
  frameCount: number
): { cols: number; rows: number; cellW: number; cellH: number } {
  const cols = Math.max(1, Math.min(frameCount, Math.ceil(Math.sqrt(frameCount))));
  const rows = Math.max(1, Math.ceil(frameCount / cols));
  const native = computeNativeExportCellSize(bounds, 1536);
  let cellW = native.width;
  let cellH = native.height;

  // Guard against browser GPU canvas hard limits (~12288px side or ~64MP total) while keeping 1:1 whenever possible
  const MAX_SHEET_SIDE = 12288;
  const MAX_SHEET_PIXELS = 64 * 1024 * 1024;
  let scale = 1;
  if (cols * cellW > MAX_SHEET_SIDE) {
    scale = Math.min(scale, MAX_SHEET_SIDE / (cols * cellW));
  }
  if (rows * cellH > MAX_SHEET_SIDE) {
    scale = Math.min(scale, MAX_SHEET_SIDE / (rows * cellH));
  }
  const totalPixels = cols * cellW * scale * (rows * cellH * scale);
  if (totalPixels > MAX_SHEET_PIXELS) {
    scale *= Math.sqrt(MAX_SHEET_PIXELS / totalPixels);
  }
  if (scale < 1) {
    cellW = Math.max(128, Math.floor(cellW * scale));
    cellH = Math.max(128, Math.floor(cellH * scale));
  }
  return { cols, rows, cellW, cellH };
}

export function exportAnimationStripPng(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  fps = 24,
  compositeLayers: CompositeSpineLayer[] = []
): { dataUrl: string; frameCount: number; cellWidth: number; cellHeight: number } {
  const baseDuration = getAnimationDuration(skeleton, animName);
  const duration = getCompositeAnimationDuration(baseDuration, compositeLayers);
  const frameCount = Math.max(1, Math.min(180, Math.round(duration * fps)));
  const bounds = computeCompositeAnimationWorldBounds(
    skeleton,
    animName,
    regionCanvasMap,
    compositeLayers,
    24
  );
  const { cols, rows, cellW, cellH } = computeStripLayout(bounds, frameCount);

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = cols * cellW;
  sheetCanvas.height = rows * cellH;
  const sheetCtx = sheetCanvas.getContext('2d');

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const frameCtx = frameCanvas.getContext('2d');

  if (sheetCtx && frameCtx) {
    sheetCtx.imageSmoothingEnabled = true;
    sheetCtx.imageSmoothingQuality = 'high';
    for (let i = 0; i < frameCount; i++) {
      const t = frameCount === 1 ? 0 : (i / frameCount) * duration;
      renderSpineFrameToCanvas(
        frameCtx,
        cellW,
        cellH,
        skeleton,
        animName,
        t,
        regionCanvasMap,
        1,
        0,
        0,
        bounds,
        compositeLayers
      );
      const col = i % cols;
      const row = Math.floor(i / cols);
      sheetCtx.drawImage(frameCanvas, col * cellW, row * cellH);
    }
  }

  return {
    dataUrl: sheetCanvas.toDataURL('image/png'),
    frameCount,
    cellWidth: cellW,
    cellHeight: cellH,
  };
}

export async function exportAnimationStripPngBlob(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  fps = 24,
  compositeLayers: CompositeSpineLayer[] = [],
  precomputedBounds?: AnimationWorldBounds | null
): Promise<{ blob: Blob | null; frameCount: number; cellWidth: number; cellHeight: number }> {
  const baseDuration = getAnimationDuration(skeleton, animName);
  const duration = getCompositeAnimationDuration(baseDuration, compositeLayers);
  const frameCount = Math.max(1, Math.min(180, Math.round(duration * fps)));
  const bounds =
    precomputedBounds ||
    computeCompositeAnimationWorldBounds(
      skeleton,
      animName,
      regionCanvasMap,
      compositeLayers,
      24
    );
  const { cols, rows, cellW, cellH } = computeStripLayout(bounds, frameCount);

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = cols * cellW;
  sheetCanvas.height = rows * cellH;
  const sheetCtx = sheetCanvas.getContext('2d');

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const frameCtx = frameCanvas.getContext('2d');

  if (sheetCtx && frameCtx) {
    sheetCtx.imageSmoothingEnabled = true;
    sheetCtx.imageSmoothingQuality = 'high';
    for (let i = 0; i < frameCount; i++) {
      const t = frameCount === 1 ? 0 : (i / frameCount) * duration;
      renderSpineFrameToCanvas(
        frameCtx,
        cellW,
        cellH,
        skeleton,
        animName,
        t,
        regionCanvasMap,
        1,
        0,
        0,
        bounds,
        compositeLayers
      );
      const col = i % cols;
      const row = Math.floor(i / cols);
      sheetCtx.drawImage(frameCanvas, col * cellW, row * cellH);
    }
  }

  const blob = await canvasToPngBlob(sheetCanvas);
  return {
    blob,
    frameCount,
    cellWidth: cellW,
    cellHeight: cellH,
  };
}

export async function exportAnimationGif(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, HTMLCanvasElement>,
  options?: {
    fps?: number;
    bounds?: AnimationWorldBounds | null;
    backgroundColor?: string | null;
    compositeLayers?: CompositeSpineLayer[];
    onProgress?: (percent: number) => void;
  }
): Promise<{ blob: Blob; frameCount: number; width: number; height: number }> {
  const fps = options?.fps ?? 24;
  const compositeLayers = options?.compositeLayers || [];
  const baseDuration = getAnimationDuration(skeleton, animName);
  const duration = getCompositeAnimationDuration(baseDuration, compositeLayers);
  const frameCount =
    duration <= 0 ? 1 : Math.max(1, Math.min(180, Math.round(duration * fps)));
  const delayMs = duration <= 0 ? 100 : Math.max(20, Math.round((duration / frameCount) * 1000));

  const bounds =
    options?.bounds ||
    computeCompositeAnimationWorldBounds(
      skeleton,
      animName,
      regionCanvasMap,
      compositeLayers,
      24
    );
  const { width: cellW, height: cellH } = computeNativeExportCellSize(bounds, 1280);

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  const bgColor = options?.backgroundColor || null;

  const gif = GIFEncoder();

  if (ctx) {
    for (let i = 0; i < frameCount; i++) {
      const t = frameCount === 1 ? 0 : (i / frameCount) * duration;
      renderSpineFrameToCanvas(
        ctx,
        cellW,
        cellH,
        skeleton,
        animName,
        t,
        regionCanvasMap,
        1,
        0,
        0,
        bounds,
        compositeLayers
      );

      if (bgColor) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, cellW, cellH);
        ctx.restore();
      }

      const imageData = ctx.getImageData(0, 0, cellW, cellH);
      const rgba = imageData.data;

      if (bgColor) {
        const palette = quantize(rgba, 256, { format: 'rgb565' });
        while (palette.length < 4) palette.push([0, 0, 0]);
        const indexed = applyPalette(rgba, palette, 'rgb565');
        const depth = Math.max(2, Math.ceil(Math.log2(palette.length)));
        gif.writeFrame(indexed, cellW, cellH, {
          palette,
          delay: delayMs,
          repeat: 0,
          dispose: 0,
          colorDepth: depth,
          transparent: false,
        });
      } else {
        // Extract only opaque pixels so transparent index 0 never collides with black outlines
        const totalPixels = cellW * cellH;
        const opaqueMask = new Uint8Array(totalPixels);
        let opaqueCount = 0;
        for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
          if (rgba[p + 3] >= 32) {
            opaqueMask[px] = 1;
            opaqueCount++;
          }
        }

        const opaqueRgba = new Uint8Array(Math.max(4, opaqueCount * 4));
        if (opaqueCount === 0) {
          opaqueRgba[0] = 0;
          opaqueRgba[1] = 0;
          opaqueRgba[2] = 0;
          opaqueRgba[3] = 255;
        } else {
          let wIdx = 0;
          for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
            if (opaqueMask[px]) {
              opaqueRgba[wIdx++] = rgba[p];
              opaqueRgba[wIdx++] = rgba[p + 1];
              opaqueRgba[wIdx++] = rgba[p + 2];
              opaqueRgba[wIdx++] = 255;
            }
          }
        }

        const opaquePalette = quantize(opaqueRgba, 255, { format: 'rgb565' });
        const finalPalette: Array<[number, number, number]> = [
          [0, 0, 0], // Index 0 is strictly reserved as the transparent background index
          ...opaquePalette.map(
            (c) => [c[0], c[1], c[2]] as [number, number, number]
          ),
        ];
        while (finalPalette.length < 4) finalPalette.push([0, 0, 0]);

        const finalIndexed = new Uint8Array(totalPixels);
        if (opaqueCount > 0) {
          const opaqueIndexed = applyPalette(rgba, opaquePalette, 'rgb565');
          for (let px = 0; px < totalPixels; px++) {
            finalIndexed[px] = opaqueMask[px] ? opaqueIndexed[px] + 1 : 0;
          }
        }

        const depth = Math.max(2, Math.ceil(Math.log2(finalPalette.length)));
        gif.writeFrame(finalIndexed, cellW, cellH, {
          palette: finalPalette,
          delay: delayMs,
          repeat: 0,
          dispose: 2,
          colorDepth: depth,
          transparent: true,
          transparentIndex: 0,
        });
      }

      options?.onProgress?.(Math.round(((i + 1) / frameCount) * 100));
      if (i % 3 === 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  gif.finish();
  const bytes = gif.bytes();
  return {
    blob: new Blob([bytes], { type: 'image/gif' }),
    frameCount,
    width: cellW,
    height: cellH,
  };
}

export async function exportUrlAssetsAsZip(
  zipFilename: string,
  items: Array<{ zipPath: string; fetchUrl: string }>,
  onProgress?: (done: number, total: number, phase: 'fetching' | 'zipping') => void
): Promise<{ exported: number; failed: number }> {
  if (items.length === 0) return { exported: 0, failed: 0 };

  const results: StreamingZipEntry[] = [];
  const usedPaths = new Set<string>();
  let done = 0;
  let failed = 0;
  let cursor = 0;

  const dedupePath = (rawPath: string) => {
    if (!usedPaths.has(rawPath)) {
      usedPaths.add(rawPath);
      return rawPath;
    }
    const dot = rawPath.lastIndexOf('.');
    const base = dot > 0 ? rawPath.slice(0, dot) : rawPath;
    const ext = dot > 0 ? rawPath.slice(dot) : '';
    let n = 2;
    while (usedPaths.has(`${base}_${n}${ext}`)) n++;
    const unique = `${base}_${n}${ext}`;
    usedPaths.add(unique);
    return unique;
  };

  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      let blob: Blob | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(item.fetchUrl, { signal: AbortSignal.timeout(20_000) });
          if (resp.ok) {
            blob = await resp.blob();
            break;
          }
        } catch {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 350));
          }
        }
      }

      if (blob && blob.size > 0) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        results.push({
          path: dedupePath(item.zipPath),
          blob,
          size: bytes.byteLength,
          crc32: computeCrc32(bytes),
        });
      } else {
        failed++;
      }

      done++;
      onProgress?.(done, items.length, 'fetching');
    }
  };

  const concurrency = Math.min(6, items.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (results.length === 0) {
    throw new Error('Não foi possível baixar nenhum dos arquivos selecionados.');
  }

  results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  onProgress?.(items.length, items.length, 'zipping');

  const blob = await assembleStreamingZipBlob(
    async function* (): AsyncGenerator<StreamingZipEntry[]> {
      for (let i = 0; i < results.length; i += 24) {
        yield results.slice(i, i + 24);
      }
    },
    results.length
  );

  downloadBlob(blob, zipFilename);
  return { exported: results.length, failed };
}

export async function sliceImageUrlToZip(
  imageUrl: string,
  zipFilename: string,
  options?: {
    folder?: string;
    filePrefix?: string;
    alphaThreshold?: number;
    minSize?: number;
    mergeGap?: number;
  }
): Promise<number> {
  const img = await loadImageElement(imageUrl);
  const sliced = sliceImageByAutoBBox(
    img,
    options?.alphaThreshold ?? 12,
    options?.minSize ?? 12,
    options?.mergeGap ?? 2
  );
  if (sliced.length === 0) {
    throw new Error('Nenhum sprite/emoji isolado detectado na imagem.');
  }

  const folder = options?.folder ? `${options.folder.replace(/\/+$/, '')}/` : '';
  const prefix = options?.filePrefix || 'sprite';

  const entries: StreamingZipEntry[] = [];
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) throw new Error('Contexto 2D indisponível.');

  for (let i = 0; i < sliced.length; i++) {
    const f = sliced[i];
    tempCanvas.width = f.sourceWidth;
    tempCanvas.height = f.sourceHeight;
    tempCtx.clearRect(0, 0, f.sourceWidth, f.sourceHeight);
    tempCtx.drawImage(
      img,
      f.sourceX,
      f.sourceY,
      f.sourceWidth,
      f.sourceHeight,
      0,
      0,
      f.sourceWidth,
      f.sourceHeight
    );
    const pngBlob = await canvasToPngBlob(tempCanvas);
    if (pngBlob) {
      const bytes = new Uint8Array(await pngBlob.arrayBuffer());
      entries.push({
        path: `${folder}${prefix}_${String(i + 1).padStart(3, '0')}.png`,
        blob: pngBlob,
        size: bytes.byteLength,
        crc32: computeCrc32(bytes),
      });
    }
  }

  const zipBlob = await assembleStreamingZipBlob(
    async function* (): AsyncGenerator<StreamingZipEntry[]> {
      for (let i = 0; i < entries.length; i += 24) {
        yield entries.slice(i, i + 24);
      }
    },
    entries.length
  );

  downloadBlob(zipBlob, zipFilename);
  return entries.length;
}


