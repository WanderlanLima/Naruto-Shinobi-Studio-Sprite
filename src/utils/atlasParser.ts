import { GIFEncoder } from 'gifenc';
import type {
  AnimationImpactMetrics,
  AtlasPage,
  AtlasRegion,
  AtlasRegionSprite,
  CompositeSpineLayer,
  EffectPlacementSpace,
  ScreenEffectFraming,
  SkeletonBlendSummary,
  SlicedFrame,
  SpineAnimationData,
  SpineAttachmentInfo,
  SpineAudioEventRef,
  SpineBlendModeName,
  SpineBoneDef,
  SpineCameraCue,
  SpineChoreographyCues,
  SpineCommandEffectRef,
  SpineHitEventRef,
  SpineMovementCue,
  SpinePhaseCue,
  SpineScreenCue,
  SpineShowFeatureRef,
  SpineSlotDef,
  SpineSkeleton,
  SpineVideoEventRef,
  SpriteRegionSource,
} from '../types/sprite';
import { exportWorkerPool, type QuantizedGifFrameResult } from './exportWorkerPool';
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
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        img
          .decode()
          .then(() => resolve(img))
          .catch(() => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error(`Falha ao carregar imagem: ${src}`));
    img.src = src;
  });
}

function drawAtlasRegionOnContext(
  ctx: CanvasRenderingContext2D,
  region: AtlasRegion,
  pageImage: HTMLImageElement,
  outW: number,
  outH: number
) {
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
}

export function createAtlasRegionSprite(
  region: AtlasRegion,
  pageImage: HTMLImageElement
): AtlasRegionSprite {
  return {
    kind: 'atlas-region',
    image: pageImage,
    region,
    width: Math.max(1, region.origWidth || region.width),
    height: Math.max(1, region.origHeight || region.height),
  };
}

export function buildRegionSpriteMap(
  pages: AtlasPage[],
  pageImages: Record<string, HTMLImageElement>
): Map<string, SpriteRegionSource> {
  const map = new Map<string, SpriteRegionSource>();
  for (const page of pages) {
    const img = pageImages[page.name];
    if (!img) continue;
    for (const reg of page.regions) {
      map.set(reg.name, createAtlasRegionSprite(reg, img));
    }
  }
  return map;
}

export function isAtlasRegionSprite(
  source: SpriteRegionSource
): source is AtlasRegionSprite {
  return (
    typeof source === 'object' &&
    source !== null &&
    'kind' in source &&
    source.kind === 'atlas-region'
  );
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

  drawAtlasRegionOnContext(ctx, region, pageImage, outW, outH);
  return canvas;
}

export function sliceAtlasRegions(
  pages: AtlasPage[],
  pageImages: Record<string, HTMLImageElement>
): SlicedFrame[] {
  const frames: SlicedFrame[] = [];
  // Reuse a single scratch canvas to avoid exhausting Android Chrome's GPU canvas surface limit
  const scratch = document.createElement('canvas');
  const ctx = scratch.getContext('2d');

  for (const page of pages) {
    const img = pageImages[page.name];
    if (!img) continue;
    for (let i = 0; i < page.regions.length; i++) {
      const region = page.regions[i];
      const outW = Math.max(1, region.origWidth || region.width);
      const outH = Math.max(1, region.origHeight || region.height);
      scratch.width = outW;
      scratch.height = outH;
      if (ctx) {
        ctx.clearRect(0, 0, outW, outH);
        drawAtlasRegionOnContext(ctx, region, img, outW, outH);
      }
      frames.push({
        id: `${page.name}::${region.name}::${region.index}::${i}`,
        name: region.index >= 0 ? `${region.name}_${region.index}` : region.name,
        width: outW,
        height: outH,
        sourceX: region.x,
        sourceY: region.y,
        sourceWidth: region.width,
        sourceHeight: region.height,
        rotate: region.rotate,
        dataUrl: scratch.toDataURL('image/png'),
      });
    }
  }
  // Release GPU backing buffer immediately
  scratch.width = 0;
  scratch.height = 0;
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
      // Support both closed {...} and malformed unclosed {DISPLAYONFIGHTER:... at end of string
      const cmdMatches = ev.string.matchAll(/\{([A-Za-z0-9_]+):([^}]+)(?:\}|$)/g);
      for (const m of cmdMatches) {
        const cmdType = m[1];
        const body = m[2];
        if (!cmdType.startsWith('DISPLAY')) continue;

        const spineMatch = body.match(/spine\s*=\s*["']([^"']+)["']/);
        const sourceMatch = body.match(/source\s*=\s*["']([^"']+)["']/);
        if (!spineMatch?.[1] || !sourceMatch?.[1]) continue;

        const layerMatch = body.match(/layer\s*=\s*["']([^"']+)["']/);
        const loopMatch = body.match(/loop\s*=\s*["']([^"']+)["']/);
        const targetsListMatch = body.match(/targets\s*=\s*\[([^\]]*)\]/i);
        const parsedTargets = targetsListMatch
          ? Array.from(targetsListMatch[1].matchAll(/["']([^"']+)["']/g))
              .map((tm) => tm[1].trim())
              .filter(Boolean)
          : undefined;
        const targets = parsedTargets && parsedTargets.length > 0 ? parsedTargets : undefined;
        const hasExplicitTargets = /targets\s*=\s*\[/i.test(body);
        const hasSelfTarget = /targets\s*=\s*\[[^\]]*["']self["'][^\]]*\]/i.test(body);

        const spineId = spineMatch[1].trim();
        const effectAnim = sourceMatch[1].trim();
        const layerVal = (layerMatch?.[1] || '').toLowerCase();
        const layer: 'behind' | 'front' =
          layerVal === 'rbg' || layerVal === 'bg' ? 'behind' : 'front';
        const loopVal = (loopMatch?.[1] || '').toLowerCase();
        const loop = loopVal === 'true' || loopVal === '1' || loopVal === 'loop';
        const isGenericImpactSpine =
          /^(?:noe_)?(?:f?dajitexiao\d*|dianliu|huoshouji|feng|erweibaodian|vdf_.*_hit)$/i.test(
            spineId
          );
        const isSelfOrScreen =
          cmdType === 'DISPLAY' ||
          hasSelfTarget ||
          (!hasExplicitTargets && !isGenericImpactSpine);
        const startTime = Math.max(0, ev.time || 0);

        const telaMatch = body.match(/\btela\s*=\s*["']?(-?\d+)["']?/i);
        const cenaMatch = body.match(/\bcena\s*=\s*["']?(-?\d+)["']?/i);
        const telaParsed = telaMatch ? Number(telaMatch[1]) : undefined;
        const cenaParsed = cenaMatch ? Number(cenaMatch[1]) : undefined;
        const tela = typeof telaParsed === 'number' && Number.isFinite(telaParsed) ? telaParsed : undefined;
        const cena = typeof cenaParsed === 'number' && Number.isFinite(cenaParsed) ? cenaParsed : undefined;

        const isFullscreen =
          (typeof tela === 'number' && tela >= 5) ||
          /^(?:quanping|qunping|.*tips|beijing|qp(?:_ziji)?)$/i.test(effectAnim);
        const space: EffectPlacementSpace = isFullscreen
          ? 'screen'
          : hasSelfTarget || (isSelfOrScreen && (!targets || targets.length === 0))
          ? 'self'
          : targets && targets.length > 0
          ? 'target'
          : cmdType === 'DISPLAYONFIGHTER'
          ? 'target'
          : 'world';

        const key = `${spineId}::${effectAnim}::${startTime.toFixed(4)}::${layer}::${tela ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        refs.push({
          spineId,
          animName: effectAnim,
          startTime,
          layer,
          isSelfOrScreen,
          loop,
          ...(tela !== undefined ? { tela } : {}),
          ...(cena !== undefined ? { cena } : {}),
          ...(targets ? { targets } : {}),
          space,
          rawCommand: m[0],
        });
      }
    }
  }

  return refs;
}

export function isFullscreenEffectRef(ref: {
  animName?: string;
  tela?: number;
}): boolean {
  if (typeof ref.tela === 'number' && ref.tela >= 5) return true;
  const anim = (ref.animName || '').trim();
  return /^(?:quanping|qunping|.*tips|beijing|qp(?:_ziji)?)$/i.test(anim);
}

export function extractSpineHitRefs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineHitEventRef[] {
  if (!skeleton || !animName) return [];
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const refs: SpineHitEventRef[] = [];
  const seen = new Set<string>();

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;
    for (const ev of anim.events) {
      if (!ev.string) continue;
      for (const m of ev.string.matchAll(/\{HIT:([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gi)) {
        const body = m[1] || '';
        const targetMatch = body.match(/\btarget\s*=\s*["']([^"']+)["']/i);
        const pMatch = body.match(/\bp\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
        const hurtMatch = body.match(/\bhurtAnim\s*=\s*["']([^"']+)["']/i);
        const blowupMatch = body.match(/\bblowup\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
        const velMatch = body.match(/\bv\s*=\s*\{([^}]*)\}/i);
        let velocity: { x?: number; y?: number } | undefined;
        if (velMatch?.[1]) {
          const vxM = velMatch[1].match(/\bx\s*=\s*(-?\d+(?:\.\d+)?)/i);
          const vyM = velMatch[1].match(/\by\s*=\s*(-?\d+(?:\.\d+)?)/i);
          const vx = vxM ? Number(vxM[1]) : undefined;
          const vy = vyM ? Number(vyM[1]) : undefined;
          if (
            (typeof vx === 'number' && Number.isFinite(vx)) ||
            (typeof vy === 'number' && Number.isFinite(vy))
          ) {
            velocity = {
              ...(typeof vx === 'number' && Number.isFinite(vx) ? { x: vx } : {}),
              ...(typeof vy === 'number' && Number.isFinite(vy) ? { y: vy } : {}),
            };
          }
        }
        const finalMatch = body.match(/\bfinal\s*=\s*["']?([^"',\s}]+)["']?/i);
        const target = targetMatch?.[1]?.trim() || undefined;
        const pVal = pMatch ? Number(pMatch[1]) : undefined;
        const hurtAnim = hurtMatch?.[1]?.trim() || undefined;
        const blowupVal = blowupMatch ? Number(blowupMatch[1]) : undefined;
        const finalStr = (finalMatch?.[1] || '').toLowerCase();
        const isFinal = finalStr === '1' || finalStr === 'true';
        const time = Math.max(0, ev.time || 0);
        const dedupeKey = `${time.toFixed(4)}::${target ?? ''}::${pVal ?? ''}::${hurtAnim ?? ''}::${isFinal ? 1 : 0}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        refs.push({
          time,
          ...(target ? { target } : {}),
          ...(typeof pVal === 'number' && Number.isFinite(pVal) ? { p: pVal } : {}),
          ...(hurtAnim ? { hurtAnim } : {}),
          ...(typeof blowupVal === 'number' && Number.isFinite(blowupVal)
            ? { blowup: blowupVal }
            : {}),
          ...(velocity ? { velocity } : {}),
          ...(isFinal ? { final: true } : {}),
          rawCommand: m[0],
        });
      }
    }
  }

  return refs.sort((a, b) => a.time - b.time);
}

/**
 * Finds the animation inside a companion particle skeleton (`_ground`, `_effect`, `_highteffect`)
 * that corresponds to the character's current animation (never falling back to an unrelated anim).
 */
export function findMatchingCompanionAnimName(
  companionSkeleton: SpineSkeleton | null | undefined,
  animName: string,
  effectiveAnim?: string
): string | null {
  if (!companionSkeleton?.animations || !animName) return null;
  const available = Object.keys(companionSkeleton.animations);
  if (available.length === 0) return null;

  const candidates: string[] = [];
  if (effectiveAnim) candidates.push(effectiveAnim);
  if (!candidates.includes(animName)) candidates.push(animName);

  for (const cand of candidates) {
    const exact = available.find((a) => a === cand);
    if (exact && hasVisibleAnimationContent(companionSkeleton, exact)) return exact;
    const candLow = cand.trim().toLowerCase();
    const ci = available.find((a) => a.trim().toLowerCase() === candLow);
    if (ci && hasVisibleAnimationContent(companionSkeleton, ci)) return ci;
  }
  return null;
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
  if (t < firstTime - 1e-5) {
    return defaultVal;
  }
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
  if (t < firstTime - 1e-5) return 0;
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
  if (time < firstTime - 1e-5) return null;
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
  spriteSource: SpriteRegionSource,
  r: number,
  g: number,
  b: number
): HTMLCanvasElement | null {
  if (!tintScratchCanvas && typeof document !== 'undefined') {
    tintScratchCanvas = document.createElement('canvas');
  }
  if (!tintScratchCanvas) return isAtlasRegionSprite(spriteSource) ? null : spriteSource;
  const w = Math.max(1, spriteSource.width);
  const h = Math.max(1, spriteSource.height);
  if (tintScratchCanvas.width !== w) tintScratchCanvas.width = w;
  if (tintScratchCanvas.height !== h) tintScratchCanvas.height = h;
  const tctx = tintScratchCanvas.getContext('2d');
  if (!tctx) return isAtlasRegionSprite(spriteSource) ? null : spriteSource;

  const drawRaw = () => {
    if (isAtlasRegionSprite(spriteSource)) {
      drawAtlasRegionOnContext(tctx, spriteSource.region, spriteSource.image, w, h);
    } else {
      tctx.drawImage(spriteSource, 0, 0);
    }
  };

  tctx.globalCompositeOperation = 'source-over';
  tctx.clearRect(0, 0, w, h);
  drawRaw();
  // Multiply RGB color while preserving the sprite's exact alpha channel
  tctx.globalCompositeOperation = 'multiply';
  tctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tctx.fillRect(0, 0, w, h);
  tctx.globalCompositeOperation = 'destination-in';
  drawRaw();
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
  regionCanvasMap: Map<string, SpriteRegionSource>,
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
  regionCanvasMap: Map<string, SpriteRegionSource>,
  samples = 24
): AnimationWorldBounds {
  return computeCompositeAnimationWorldBounds(skeleton, animName, regionCanvasMap, [], samples);
}

export function computeCompositeAnimationWorldBounds(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, SpriteRegionSource>,
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
  regionCanvasMap: Map<string, SpriteRegionSource>
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
    const spriteSource = regionCanvasMap.get(regionKey);
    if (!spriteSource) continue;

    const needsTint = slotColor.r < 248 || slotColor.g < 248 || slotColor.b < 248;
    const tintedCanvas = needsTint
      ? getTintedSpriteCanvas(spriteSource, slotColor.r, slotColor.g, slotColor.b)
      : null;

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
    const aw = attInfo?.width || spriteSource.width;
    const ah = attInfo?.height || spriteSource.height;

    ctx.translate(ax, ay);
    if (arot !== 0) ctx.rotate(arot);
    // Negate Y scale to draw upright image inside Spine Y-up space
    ctx.scale(asx, -asy);

    if (tintedCanvas) {
      ctx.drawImage(tintedCanvas, -aw / 2, -ah / 2, aw, ah);
    } else if (isAtlasRegionSprite(spriteSource)) {
      const outW = spriteSource.width;
      const outH = spriteSource.height;
      ctx.translate(-aw / 2, -ah / 2);
      if (aw !== outW || ah !== outH) {
        ctx.scale(aw / outW, ah / outH);
      }
      drawAtlasRegionOnContext(ctx, spriteSource.region, spriteSource.image, outW, outH);
    } else {
      ctx.drawImage(spriteSource, -aw / 2, -ah / 2, aw, ah);
    }

    ctx.restore();
    drawnSlots++;
  }

  return drawnSlots;
}

export interface BattlePreviewOptions {
  enabled: boolean;
  /** World-space X distance from ninja feet (0,0) to enemy dummy (e.g. 120..480) */
  targetDistance: number;
  /** Show ground line, feet anchor crosshair, and distance guide */
  showGuides?: boolean;
}

export interface RenderSpineFrameOptions {
  fillRatio?: number;
  maxAutoFitScale?: number;
  followFramePose?: boolean;
  battlePreview?: BattlePreviewOptions;
}

function drawBattlePreviewGuidesAndDummy(
  ctx: CanvasRenderingContext2D,
  targetDistance: number,
  impactActive: boolean,
  showGuides: boolean
) {
  ctx.save();

  // Ground line at y = 0 (Spine world floor)
  if (showGuides) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-260, 0);
    ctx.lineTo(targetDistance + 220, 0);
    ctx.stroke();

    // Subtle distance ticks between ninja (0) and dummy (targetDistance)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    const step = 60;
    for (let x = step; x < targetDistance - 15; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, -5);
      ctx.lineTo(x, 5);
      ctx.stroke();
    }

    // Trajectory guide dashed line from ninja chest to dummy chest
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = impactActive ? 'rgba(249, 115, 22, 0.55)' : 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(28, 62);
    ctx.lineTo(targetDistance - 24, 62);
    ctx.stroke();
    ctx.restore();

    // Ninja feet anchor crosshair at (0, 0)
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(10, 0);
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 10);
    ctx.stroke();
    ctx.fillStyle = 'rgba(249, 115, 22, 0.22)';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Enemy tactical dummy at (targetDistance, 0)
  ctx.save();
  ctx.translate(targetDistance, 0);

  // Ground shadow
  ctx.fillStyle = impactActive ? 'rgba(244, 63, 94, 0.35)' : 'rgba(15, 23, 42, 0.55)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 34, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  const bodyFill = impactActive ? 'rgba(244, 63, 94, 0.28)' : 'rgba(100, 116, 139, 0.22)';
  const bodyStroke = impactActive ? 'rgba(251, 113, 133, 0.95)' : 'rgba(148, 163, 184, 0.65)';

  // Post / stand
  ctx.fillStyle = bodyFill;
  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 2;

  // Base pole
  ctx.beginPath();
  ctx.rect(-5, 0, 10, 34);
  ctx.fill();
  ctx.stroke();

  // Torso (training straw dummy silhouette)
  ctx.beginPath();
  ctx.roundRect(-20, 34, 40, 56, 8);
  ctx.fill();
  ctx.stroke();

  // Crossbar arms
  ctx.beginPath();
  ctx.roundRect(-34, 72, 68, 10, 4);
  ctx.fill();
  ctx.stroke();

  // Head
  ctx.beginPath();
  ctx.arc(0, 108, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Bullseye target mark on chest
  ctx.strokeStyle = impactActive ? 'rgba(253, 186, 116, 0.95)' : 'rgba(249, 115, 22, 0.72)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, 62, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 62, 4, 0, Math.PI * 2);
  ctx.stroke();

  // Impact flash shockwave ring when hit VFX is active
  if (impactActive) {
    ctx.strokeStyle = 'rgba(251, 113, 133, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 62, 42, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Flip Y locally to render crisp upright label under dummy
  ctx.scale(1, -1);
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = impactActive ? 'rgba(253, 164, 175, 0.95)' : 'rgba(148, 163, 184, 0.85)';
  ctx.fillText(impactActive ? 'IMPACTO' : `ALVO (${Math.round(targetDistance)}px)`, 0, 22);

  ctx.restore();
  ctx.restore();
}

export function renderSpineFrameToCanvas(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  skeleton: SpineSkeleton,
  animName: string,
  time: number,
  regionCanvasMap: Map<string, SpriteRegionSource>,
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
  const battlePreview = options?.battlePreview?.enabled ? options.battlePreview : null;
  const targetDistance = battlePreview ? Math.max(80, battlePreview.targetDistance) : 0;

  let effectiveBounds = autoFitBounds || null;
  if (battlePreview && effectiveBounds) {
    const minX = Math.min(effectiveBounds.minX, -95);
    const maxX = Math.max(effectiveBounds.maxX, targetDistance + 95);
    const minY = Math.min(effectiveBounds.minY, -34);
    const maxY = Math.max(effectiveBounds.maxY, 175);
    const width = Math.max(240, maxX - minX);
    const height = Math.max(180, maxY - minY);
    effectiveBounds = {
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    };
  }

  let effectiveScale: number;
  let anchorX: number;
  let anchorY: number;

  if (effectiveBounds) {
    const fitScale = Math.min(
      (canvasWidth * fillRatio) / effectiveBounds.width,
      (canvasHeight * fillRatio) / effectiveBounds.height
    );
    const baseScale = Math.min(maxAutoFitScale, Math.max(0.05, fitScale));
    effectiveScale = baseScale * zoom;

    let targetCenterX = effectiveBounds.centerX;
    let targetCenterY = effectiveBounds.centerY;

    if (options?.followFramePose && zoom > 1.0 && !battlePreview) {
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
        targetCenterX = effectiveBounds.centerX + (frameCx - effectiveBounds.centerX) * blend;
        targetCenterY = effectiveBounds.centerY + (frameCy - effectiveBounds.centerY) * blend;
      }
    }

    anchorX = canvasWidth / 2 - targetCenterX * effectiveScale + panX;
    anchorY = canvasHeight / 2 + targetCenterY * effectiveScale + panY;
  } else {
    const skelBounds = skeleton.skeleton || {};
    const skelW = Math.max(80, (skelBounds.width || 160) + (battlePreview ? targetDistance + 120 : 0));
    const skelH = Math.max(80, skelBounds.height || 160);
    const baseScale = Math.min((canvasWidth * 0.72) / skelW, (canvasHeight * 0.72) / skelH);
    effectiveScale = Math.min(maxAutoFitScale, Math.max(0.15, baseScale)) * zoom;
    anchorX = canvasWidth / 2 - (battlePreview ? (targetDistance * effectiveScale) / 2 : 0) + panX;
    anchorY = canvasHeight * 0.76 + panY;
  }

  let drawnSlots = 0;

  ctx.save();
  // Spine Y-up coordinate space anchored near bottom-center
  ctx.translate(anchorX, anchorY);
  ctx.scale(effectiveScale, -effectiveScale);

  const isLayerActiveAtTime = (layer: CompositeSpineLayer): boolean => {
    if (time < layer.startTime) return false;
    const elapsed = time - layer.startTime;
    if (!layer.loop && elapsed > layer.duration) return false;
    return true;
  };

  if (battlePreview) {
    const impactActive = compositeLayers.some(
      (layer) => layer.isSelfOrScreen === false && isLayerActiveAtTime(layer)
    );
    drawBattlePreviewGuidesAndDummy(
      ctx,
      targetDistance,
      impactActive,
      battlePreview.showGuides !== false
    );
  }

  const renderLayer = (layer: CompositeSpineLayer) => {
    if (!isLayerActiveAtTime(layer)) return;
    const elapsed = time - layer.startTime;
    const localT =
      layer.loop && layer.duration > 0 ? elapsed % layer.duration : elapsed;
    const shiftToTarget = Boolean(battlePreview && layer.isSelfOrScreen === false);
    if (shiftToTarget) {
      ctx.save();
      ctx.translate(targetDistance, 0);
    }
    drawnSlots += drawSkeletonAtTime(
      ctx,
      layer.skeleton,
      layer.animName,
      localT,
      layer.regionCanvasMap
    );
    if (shiftToTarget) {
      ctx.restore();
    }
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

export function computeStripLayout(
  bounds: AnimationWorldBounds,
  frameCount: number,
  maxCellSide = 1536
): { cols: number; rows: number; cellW: number; cellH: number } {
  const cols = Math.max(1, Math.min(frameCount, Math.ceil(Math.sqrt(frameCount))));
  const rows = Math.max(1, Math.ceil(frameCount / cols));
  const native = computeNativeExportCellSize(bounds, maxCellSide);
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
  regionCanvasMap: Map<string, SpriteRegionSource>,
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
  regionCanvasMap: Map<string, SpriteRegionSource>,
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

export function writeQuantizedGifFrame(
  gif: ReturnType<typeof GIFEncoder>,
  quantized: QuantizedGifFrameResult,
  width: number,
  height: number,
  delayMs: number
): void {
  if (quantized.transparent) {
    gif.writeFrame(quantized.indexed, width, height, {
      palette: quantized.palette,
      delay: delayMs,
      repeat: 0,
      dispose: 2,
      colorDepth: quantized.depth,
      transparent: true,
      transparentIndex: 0,
    });
  } else {
    gif.writeFrame(quantized.indexed, width, height, {
      palette: quantized.palette,
      delay: delayMs,
      repeat: 0,
      dispose: 0,
      colorDepth: quantized.depth,
      transparent: false,
    });
  }
}

export async function exportAnimationGif(
  skeleton: SpineSkeleton,
  animName: string,
  regionCanvasMap: Map<string, SpriteRegionSource>,
  options?: {
    fps?: number;
    maxResolution?: number;
    bounds?: AnimationWorldBounds | null;
    backgroundColor?: string | null;
    compositeLayers?: CompositeSpineLayer[];
    onProgress?: (percent: number) => void;
  }
): Promise<{ blob: Blob; frameCount: number; width: number; height: number }> {
  const fps = options?.fps ?? 24;
  const maxGifSide = Math.min(1280, options?.maxResolution ?? 1280);
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
  const { width: cellW, height: cellH } = computeNativeExportCellSize(bounds, maxGifSide);

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = cellW;
  frameCanvas.height = cellH;
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  const bgColor = options?.backgroundColor || null;

  const gif = GIFEncoder();

  if (ctx) {
    const maxInFlight = Math.max(2, exportWorkerPool.concurrency * 2);
    const pending: Array<Promise<QuantizedGifFrameResult>> = [];
    let written = 0;

    const flushOldest = async () => {
      const next = pending.shift();
      if (!next) return;
      const quantized = await next;
      writeQuantizedGifFrame(gif, quantized, cellW, cellH, delayMs);
      written++;
      options?.onProgress?.(Math.round((written / frameCount) * 100));
    };

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
      pending.push(
        exportWorkerPool.quantizeGifFrame(
          imageData.data.buffer as ArrayBuffer,
          cellW,
          cellH,
          Boolean(bgColor)
        )
      );

      if (pending.length >= maxInFlight) {
        await flushOldest();
      } else if (i % 6 === 5) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    while (pending.length > 0) {
      await flushOldest();
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

export interface SampledEmitterPoint {
  /** Pixel X offset relative to character feet pivot (Phaser screen space: +X right) */
  x: number;
  /** Pixel Y offset relative to character feet pivot (Phaser screen space: -Y up, +Y down) */
  y: number;
  /** Name of the detected bone or fallback source label */
  bone: string;
  /** How the point was determined */
  source: 'bone' | 'overlay' | 'bounds';
}

function scoreAttackEmitterBoneName(name: string): number {
  const low = name.trim().toLowerCase();
  if (!low || low === 'root' || low === 'no_corpo' || /^l\d+$/.test(low) || low === 'di') {
    return 0;
  }
  if (/(weapon|wuqi|guadian|muzzle|emit|shoot|firepoint|sword|jian|dao|blade|kunai|staff|bow|shuriken|fan|spear|gun)/i.test(low)) {
    return 100;
  }
  if (/(r_?hand|hand_?r|right_?hand|youshou|front_?hand|hand_?f)/i.test(low)) {
    return 90;
  }
  if (/(hand|shou|fist|quan|palm|claw|arm_?r|r_?arm|right_?arm)/i.test(low)) {
    return 78;
  }
  if (/(atk|attack|hitpoint|cast|point|eff)/i.test(low)) {
    return 56;
  }
  return 0;
}

/**
 * Finds the best candidate hand/weapon/emitter bone on a Spine skeleton for spawning projectiles.
 * Returns null for frame-baked skeletons (e.g. `vdfno_*` with only root/no_corpo/L0..Ln).
 */
export function detectAttackEmitterBoneName(
  skeleton: SpineSkeleton | null | undefined
): string | null {
  if (!skeleton?.bones?.length) return null;
  let bestName: string | null = null;
  let bestScore = 0;
  for (const b of skeleton.bones) {
    const score = scoreAttackEmitterBoneName(b.name);
    if (score > bestScore) {
      bestScore = score;
      bestName = b.name;
    }
  }
  return bestName;
}

/**
 * Samples the world-space projectile/strike origin at a given animation time and converts it
 * to Phaser pixel coordinates relative to the character's feet pivot (0, 0).
 */
export function sampleAttackEmitterPointAtTime(
  skeleton: SpineSkeleton,
  animName: string,
  time: number,
  regionCanvasMap: Map<string, SpriteRegionSource>,
  worldToPixelScale = 1,
  facing: 'right' | 'left' = 'right',
  preferredBoneName?: string | null
): SampledEmitterPoint {
  const anim = skeleton.animations?.[animName];
  const boneMap = buildBoneMap(skeleton);
  const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, time);
  const scale = Number.isFinite(worldToPixelScale) && worldToPixelScale > 0 ? worldToPixelScale : 1;

  const boneName =
    preferredBoneName !== undefined ? preferredBoneName : detectAttackEmitterBoneName(skeleton);

  if (boneName && boneMap.has(boneName)) {
    const wm = getWorldMatrix(boneName);
    if (Number.isFinite(wm.tx) && Number.isFinite(wm.ty)) {
      return {
        x: Math.round(wm.tx * scale),
        y: Math.round(-wm.ty * scale),
        bone: boneName,
        source: 'bone',
      };
    }
  }

  // Fallback 1: check active foreground/weapon overlay slots (e.g. L1..L10 on frame-baked vdfno_* skeletons)
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  let bestOverlay: { wx: number; wy: number; slotName: string; reach: number } | null = null;
  for (const slot of slotsDef) {
    if (!/^l[1-9]\d*$/i.test(slot.bone) && !/(eff|atk|weapon|wuqi|hand|shou)/i.test(slot.name)) {
      continue;
    }
    const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, time);
    if (!attachmentName) continue;
    if (sampleSlotAlpha(slot, anim, time) <= 0.05) continue;
    const attInfo = skinAttachments[slot.name]?.[attachmentName];
    const regionKey = attInfo?.path || attInfo?.name || attachmentName;
    if (!regionCanvasMap.has(regionKey)) continue;
    const wm = getWorldMatrix(slot.bone);
    const wx = wm.a * (attInfo?.x || 0) + wm.c * (attInfo?.y || 0) + wm.tx;
    const wy = wm.b * (attInfo?.x || 0) + wm.d * (attInfo?.y || 0) + wm.ty;
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
    const reach = facing === 'left' ? -wx : wx;
    if (!bestOverlay || reach > bestOverlay.reach) {
      bestOverlay = { wx, wy, slotName: slot.bone || slot.name, reach };
    }
  }
  if (bestOverlay) {
    return {
      x: Math.round(bestOverlay.wx * scale),
      y: Math.round(-bestOverlay.wy * scale),
      bone: bestOverlay.slotName,
      source: 'overlay',
    };
  }

  // Fallback 2: forward strike edge of visible frame bounds at chest/hand height (~60%)
  const frameAcc = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  accumulateSkeletonBoundsAtTime(skeleton, animName, regionCanvasMap, time, frameAcc, {
    maxSlotSpan: 2400,
  });
  if (Number.isFinite(frameAcc.minX) && Number.isFinite(frameAcc.minY)) {
    const spanX = frameAcc.maxX - frameAcc.minX;
    const spanY = frameAcc.maxY - frameAcc.minY;
    const wx =
      facing === 'left'
        ? frameAcc.minX + spanX * 0.12
        : frameAcc.maxX - spanX * 0.12;
    const wy = frameAcc.minY + spanY * 0.6;
    return {
      x: Math.round(wx * scale),
      y: Math.round(-wy * scale),
      bone: 'bounds_strike_edge',
      source: 'bounds',
    };
  }

  return {
    x: facing === 'left' ? -36 : 36,
    y: -64,
    bone: 'default_chest',
    source: 'bounds',
  };
}

export type RegionSizeLookup = {
  get(key: string): { width: number; height: number } | undefined;
};

/**
 * Pure binary ISO BMFF (`moov -> mvhd`) MP4 duration reader (milliseconds).
 * Works cleanly in browsers, Web Workers, Node, and without decoding video frames.
 */
export function parseMp4DurationMs(bytes: Uint8Array | ArrayBuffer | null | undefined): number | undefined {
  if (!bytes) return undefined;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 32) return undefined;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const readFourCC = (off: number) =>
    String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);

  const scanContainer = (start: number, end: number): number | undefined => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = dv.getUint32(offset, false);
      const type = readFourCC(offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const hi = dv.getUint32(offset + 8, false);
        const lo = dv.getUint32(offset + 12, false);
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) break;

      const boxEnd = offset + size;
      if (type === 'moov') {
        const res = scanContainer(offset + headerSize, boxEnd);
        if (res !== undefined) return res;
      } else if (type === 'mvhd') {
        const p = offset + headerSize;
        if (p + 20 <= boxEnd) {
          const version = u8[p];
          let timescale = 0;
          let duration = 0;
          if (version === 0 && p + 20 <= boxEnd) {
            timescale = dv.getUint32(p + 12, false);
            duration = dv.getUint32(p + 16, false);
          } else if (version === 1 && p + 32 <= boxEnd) {
            timescale = dv.getUint32(p + 20, false);
            const hi = dv.getUint32(p + 24, false);
            const lo = dv.getUint32(p + 28, false);
            duration = hi * 4294967296 + lo;
          }
          if (timescale > 0 && duration > 0 && Number.isFinite(duration / timescale)) {
            return Math.round((duration / timescale) * 1000);
          }
        }
      }
      offset = boxEnd;
    }
    return undefined;
  };

  return scanContainer(0, u8.byteLength);
}

/**
 * Automatically detects the exact timestamp (ms) where the post-cutscene action/explosion
 * resumes after the static/frozen cutscene wait block following `{PLAYVEDIO:...}`.
 */
export function detectVideoResumeAfterMs(
  skeleton: SpineSkeleton | null | undefined,
  animName: string,
  videoTimeSec: number,
  mp4DurationMs?: number
): number | undefined {
  if (!skeleton || !animName) {
    return mp4DurationMs !== undefined
      ? Math.max(0, Math.round(videoTimeSec * 1000 + mp4DurationMs))
      : undefined;
  }

  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const visAnim = skeleton.animations?.[effectiveAnim] || skeleton.animations?.[animName];
  const baseDuration = getAnimationDuration(skeleton, effectiveAnim);

  // Collect visual keyframes (bones + slots) sorted ascending
  const visualTimesSet = new Set<number>([0]);
  if (baseDuration > 0) visualTimesSet.add(baseDuration);
  if (visAnim?.slots) {
    for (const slotAnim of Object.values(visAnim.slots)) {
      for (const kf of slotAnim.attachment || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
      for (const kf of slotAnim.color || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
      for (const kf of slotAnim.twoColor || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
    }
  }
  if (visAnim?.bones) {
    for (const boneAnim of Object.values(visAnim.bones)) {
      for (const kf of boneAnim.translate || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
      for (const kf of boneAnim.rotate || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
      for (const kf of boneAnim.scale || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
      for (const kf of boneAnim.shear || []) {
        if (typeof kf.time === 'number') visualTimesSet.add(kf.time);
      }
    }
  }
  const visualTimes = Array.from(visualTimesSet).sort((a, b) => a - b);

  // Pattern 1: Static/frozen frame block starting near/after videoTimeSec (>= 0.45s gap)
  // with remaining post-gap timeline or post-gap events.
  let bestGap: { start: number; end: number; span: number } | null = null;
  for (let i = 0; i < visualTimes.length - 1; i++) {
    const tStart = visualTimes[i];
    const tEnd = visualTimes[i + 1];
    const span = tEnd - tStart;
    if (span < 0.45) continue;
    if (tStart < Math.max(0, videoTimeSec - 0.15)) continue;
    if (tEnd <= videoTimeSec + 0.35) continue;
    if (!bestGap || span > bestGap.span) {
      bestGap = { start: tStart, end: tEnd, span };
    }
  }

  // Also gather post-video gameplay events across wrapper & visual animation
  const postEvents: Array<{ time: number; priority: number }> = [];
  const inspectAnims =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  for (const an of inspectAnims) {
    if (!an?.events?.length) continue;
    for (const ev of an.events) {
      const t = ev.time || 0;
      if (t <= videoTimeSec + 0.25) continue;
      const s = ev.string || '';
      if (/\{HIT:/i.test(s)) {
        postEvents.push({ time: t, priority: 3 });
      } else if (/\{(?:SHOWALL|ROCK|DISPLAY|DISPLAYONFIGHTER):/i.test(s)) {
        postEvents.push({ time: t, priority: 2 });
      } else if (/\{SOUND:/i.test(s)) {
        postEvents.push({ time: t, priority: 1 });
      }
    }
  }
  postEvents.sort((a, b) => a.time - b.time);

  if (bestGap) {
    // Only use bestGap end if there is real post-gap animation/event or it isn't just trailing dead air
    const hasPostContent =
      baseDuration - bestGap.end >= 0.04 ||
      postEvents.some((ev) => ev.time >= bestGap!.end - 0.15);
    if (hasPostContent) {
      return Math.round(bestGap.end * 1000);
    }
  }

  // Pattern 2: Older/hidden-character ultimates (e.g. erwei) — resume at first post-video action event
  const significantPostEvent =
    postEvents.find((ev) => ev.priority >= 2) || postEvents[0];
  if (significantPostEvent) {
    // Prefer any visual keyframe right around or just before the post-video event
    const nearVisualResume = visualTimes.find(
      (vt) => vt > videoTimeSec + 0.35 && vt <= significantPostEvent.time + 0.05
    );
    const chosenSec = nearVisualResume ?? significantPostEvent.time;
    return Math.round(chosenSec * 1000);
  }

  if (typeof mp4DurationMs === 'number' && mp4DurationMs > 0) {
    const estEndMs = Math.round(videoTimeSec * 1000 + mp4DurationMs);
    if (baseDuration > videoTimeSec + 0.5) {
      return Math.min(Math.round(baseDuration * 1000), estEndMs);
    }
    return estEndMs;
  }

  return undefined;
}

const NON_OFFENSIVE_ANIM_RE =
  /^(?:idle|stand|wait|daiji|run|walk|move|pao|win|victory|shengli|hurt\d*|behit|die\d*|death|dead|ko|jump|fall|d_stand.*|d_air.*|charge|ready)$/i;
const OFFENSIVE_ANIM_RE =
  /^(?:attack|skill|uniqueskill|superuniqueskill|ultimate|ult|chase|gatilho|jutsu|pugong|combo)/i;
const IGNORED_IMPACT_SLOT_RE =
  /(?:^|_)(?:bg|rbg|back|ground|shadow|yingzi|aura|halo|quanping|qunping|tips|flash|screen|mask|heiping|beijing|qp)(?:$|_|\d)/i;

interface WorldBoxSample {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  slotName: string;
  boneName: string;
  isAttackLayer: boolean;
}

function collectFilteredWorldBoxesAtTime(
  skeleton: SpineSkeleton,
  animName: string,
  regionSizes: RegionSizeLookup,
  t: number,
  maxSpan = 920
): WorldBoxSample[] {
  const anim = skeleton.animations?.[animName];
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);
  const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, t);
  const out: WorldBoxSample[] = [];

  for (const slot of slotsDef) {
    if (IGNORED_IMPACT_SLOT_RE.test(slot.name)) continue;
    const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, t);
    if (!attachmentName) continue;
    if (IGNORED_IMPACT_SLOT_RE.test(attachmentName)) continue;
    if (sampleSlotAlpha(slot, anim, t) <= 0.05) continue;

    const attInfo = skinAttachments[slot.name]?.[attachmentName];
    const regionKey = attInfo?.path || attInfo?.name || attachmentName;
    if (IGNORED_IMPACT_SLOT_RE.test(regionKey)) continue;
    const rSize = regionSizes.get(regionKey);
    if (!rSize) continue;

    const wm = getWorldMatrix(slot.bone);
    const localMat = makeLocalMat(
      attInfo?.x || 0,
      attInfo?.y || 0,
      attInfo?.rotation || 0,
      attInfo?.scaleX ?? 1,
      attInfo?.scaleY ?? 1
    );
    const finalMat = mulMat(wm, localMat);
    const hw = (attInfo?.width || rSize.width) / 2;
    const hh = (attInfo?.height || rSize.height) / 2;

    const corners: Array<[number, number]> = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [cx, cy] of corners) {
      const wx = finalMat.a * cx + finalMat.c * cy + finalMat.tx;
      const wy = finalMat.b * cx + finalMat.d * cy + finalMat.ty;
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        minX = Infinity;
        break;
      }
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
    if (!Number.isFinite(minX)) continue;
    const qw = maxX - minX;
    const qh = maxY - minY;
    if (qw > maxSpan || qh > maxSpan) continue;
    // Ignore elongated speedlines
    const minSide = Math.min(qw, qh);
    const maxSide = Math.max(qw, qh);
    if (minSide > 0 && maxSide / minSide >= 6.5 && minSide <= 45) continue;

    const isAttackLayer =
      /^l[1-9]\d*$/i.test(slot.bone || '') ||
      /(?:atk|attack|eff|weapon|wuqi|sword|jian|dao|blade|slash|hit|boom|qi|skill|shou|hand)/i.test(
        `${slot.name}_${attachmentName}`
      );

    out.push({
      minX,
      maxX,
      minY,
      maxY,
      slotName: slot.name,
      boneName: slot.bone,
      isAttackLayer,
    });
  }

  return out;
}

/**
 * Calculates attack horizontal reach (`impactReachPx`) and world center (`impactCenterX`)
 * around the animation's impact timestamp, excluding background/fullscreen/self-aura slots.
 */
export function computeAttackImpactMetrics(
  skeleton: SpineSkeleton | null | undefined,
  animName: string,
  regionSizes: RegionSizeLookup | null | undefined,
  options?: {
    effectRefs?: SpineCommandEffectRef[];
    hitRefs?: SpineHitEventRef[];
    effectBundles?: Map<
      string,
      { skeleton: SpineSkeleton; regionSizes: RegionSizeLookup }
    >;
    resumeAfterMs?: number;
    isSkillInProfile?: boolean;
  }
): AnimationImpactMetrics | null {
  if (!skeleton || !animName || !regionSizes) return null;

  const hitRefs = options?.hitRefs ?? extractSpineHitRefs(skeleton, animName);
  const effectRefs = options?.effectRefs ?? extractSpineEffectRefs(skeleton, animName);
  const cleanAnim = animName.trim();
  const isExplicitNonOffensive =
    NON_OFFENSIVE_ANIM_RE.test(cleanAnim) && hitRefs.length === 0 && !options?.isSkillInProfile;
  if (isExplicitNonOffensive) return null;

  const isOffensive =
    OFFENSIVE_ANIM_RE.test(cleanAnim) ||
    hitRefs.length > 0 ||
    Boolean(options?.isSkillInProfile) ||
    effectRefs.some((r) => !isFullscreenEffectRef(r) && !r.isSelfOrScreen);
  if (!isOffensive) return null;

  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const baseDuration = getAnimationDuration(skeleton, effectiveAnim);

  const rootBone =
    skeleton.bones?.find((b) => b.name.toLowerCase() === 'root') || skeleton.bones?.[0];
  const facing: 'right' | 'left' =
    typeof rootBone?.scaleX === 'number' && rootBone.scaleX < 0 ? 'left' : 'right';

  // Determine exact impact timestamp
  let impactTimeSec: number | undefined;
  const finalHits = hitRefs.filter((h) => h.final);
  if (finalHits.length > 0) {
    impactTimeSec = finalHits[finalHits.length - 1].time;
  } else if (hitRefs.length > 0) {
    impactTimeSec = hitRefs[hitRefs.length - 1].time;
  } else {
    const targetHitVfx = effectRefs.filter(
      (r) => !isFullscreenEffectRef(r) && (!r.isSelfOrScreen || r.cena === 4)
    );
    if (targetHitVfx.length > 0) {
      impactTimeSec = targetHitVfx[targetHitVfx.length - 1].startTime;
    } else if (typeof options?.resumeAfterMs === 'number' && baseDuration > 0) {
      const resumeSec = options.resumeAfterMs / 1000;
      impactTimeSec = Math.min(baseDuration * 0.92, resumeSec + (baseDuration - resumeSec) * 0.45);
    } else {
      impactTimeSec = baseDuration * 0.6;
    }
  }

  impactTimeSec = Math.max(0, Math.min(Math.max(0, baseDuration), impactTimeSec));
  const sampleTimes = Array.from(
    new Set([
      Math.max(0, impactTimeSec - 0.04),
      impactTimeSec,
      Math.min(Math.max(0, baseDuration), impactTimeSec + 0.04),
    ])
  );

  const candidateBoxes: WorldBoxSample[] = [];
  for (const st of sampleTimes) {
    candidateBoxes.push(
      ...collectFilteredWorldBoxesAtTime(skeleton, effectiveAnim, regionSizes, st, 920)
    );

    if (options?.effectBundles) {
      for (const ref of effectRefs) {
        if (isFullscreenEffectRef(ref) || ref.layer === 'behind') continue;
        // Skip external generic hit VFX on enemy body unless character-anchored (self/cena=4)
        if (!ref.isSelfOrScreen && ref.cena !== 4) continue;
        const bundle = options.effectBundles.get(ref.spineId);
        if (!bundle) continue;
        const effElapsed = st - ref.startTime;
        if (effElapsed < -0.02) continue;
        const avail = Object.keys(bundle.skeleton.animations || {});
        const targetLow = ref.animName.trim().toLowerCase();
        const effAnimName =
          (bundle.skeleton.animations?.[ref.animName] ? ref.animName : undefined) ||
          avail.find((a) => a.trim().toLowerCase() === targetLow) ||
          avail[0];
        if (!effAnimName) continue;
        const effDur = getAnimationDuration(bundle.skeleton, effAnimName);
        if (!ref.loop && effDur > 0 && effElapsed > effDur + 0.04) continue;
        const localT =
          ref.loop && effDur > 0
            ? Math.max(0, effElapsed) % effDur
            : Math.max(0, effElapsed);

        const effBoxes = collectFilteredWorldBoxesAtTime(
          bundle.skeleton,
          effAnimName,
          bundle.regionSizes,
          localT,
          820
        ).filter((b) => {
          // Ignore pure self-centered aura boxes sitting solely behind/centered on origin unless extending forward
          const cx = (b.minX + b.maxX) / 2;
          const bw = b.maxX - b.minX;
          const isPureSelfAura = Math.abs(cx) < 35 && bw < 190 && (b.maxY - b.minY) > 120 && ref.cena !== 4;
          if (isPureSelfAura) return false;
          return true;
        });

        for (const eb of effBoxes) {
          candidateBoxes.push({ ...eb, isAttackLayer: true });
        }
      }
    }
  }

  if (candidateBoxes.length === 0) return null;

  // Prefer attack-layer or forward-extending boxes; fall back to all character strike boxes
  const attackOrForward = candidateBoxes.filter(
    (b) =>
      b.isAttackLayer ||
      (facing === 'left' ? b.minX < -25 : b.maxX > 25)
  );
  const chosen = attackOrForward.length > 0 ? attackOrForward : candidateBoxes;

  let minX = Infinity;
  let maxX = -Infinity;
  for (const b of chosen) {
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

  const impactReachPx = Math.round(Math.max(0, facing === 'left' ? -minX : maxX));
  const impactCenterX = Number(((minX + maxX) / 2).toFixed(1));

  return {
    impactMs: Math.round(impactTimeSec * 1000),
    impactReachPx,
    impactCenterX,
  };
}

/**
 * Computes `referenceViewport` and `focalBounds` for fullscreen screen effects (`tela=5`,
 * e.g. `kkxtips`, `quanping`, `tips`, `qp`), isolating the central focal visual core while
 * ignoring high-aspect speedlines and distant off-screen fly-in/fragment particles.
 */
export function computeScreenEffectFraming(
  skeleton: SpineSkeleton | null | undefined,
  animName: string,
  regionSizes: RegionSizeLookup | null | undefined,
  samples = 24
): ScreenEffectFraming | null {
  if (!skeleton || !animName || !regionSizes) return null;
  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const anim = skeleton.animations?.[effectiveAnim] || skeleton.animations?.[animName];
  if (!anim) return null;

  const duration = getAnimationDuration(skeleton, effectiveAnim);
  const sampleTimes = collectSampleTimes(anim, duration, samples);
  const slotsDef = skeleton.slots || [];
  const skinAttachments = getDefaultSkinAttachments(skeleton);
  const boneMap = buildBoneMap(skeleton);

  interface BoxItem {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
    area: number;
    isSpeedline: boolean;
  }

  const allBoxes: BoxItem[] = [];

  for (const t of sampleTimes) {
    const getWorldMatrix = createWorldMatrixResolver(boneMap, anim, t);
    for (const slot of slotsDef) {
      const attachmentName = resolveSlotAttachmentAtTime(slot.name, slot.attachment, anim, t);
      if (!attachmentName) continue;
      if (sampleSlotAlpha(slot, anim, t) <= 0.05) continue;

      const attInfo = skinAttachments[slot.name]?.[attachmentName];
      const regionKey = attInfo?.path || attInfo?.name || attachmentName;
      const rSize = regionSizes.get(regionKey);
      if (!rSize) continue;

      const wm = getWorldMatrix(slot.bone);
      const localMat = makeLocalMat(
        attInfo?.x || 0,
        attInfo?.y || 0,
        attInfo?.rotation || 0,
        attInfo?.scaleX ?? 1,
        attInfo?.scaleY ?? 1
      );
      const finalMat = mulMat(wm, localMat);
      const hw = (attInfo?.width || rSize.width) / 2;
      const hh = (attInfo?.height || rSize.height) / 2;

      const corners: Array<[number, number]> = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [cx, cy] of corners) {
        const wx = finalMat.a * cx + finalMat.c * cy + finalMat.tx;
        const wy = finalMat.b * cx + finalMat.d * cy + finalMat.ty;
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
          minX = Infinity;
          break;
        }
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      if (!Number.isFinite(minX)) continue;
      const w = maxX - minX;
      const h = maxY - minY;
      if (w < 6 || h < 6) continue;
      const minSide = Math.min(w, h);
      const maxSide = Math.max(w, h);
      const isSpeedline = minSide <= 60 && maxSide / Math.max(1, minSide) >= 6.5;

      allBoxes.push({
        minX,
        maxX,
        minY,
        maxY,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w,
        h,
        area: w * h,
        isSpeedline,
      });
    }
  }

  if (allBoxes.length === 0) return null;

  const substantial = allBoxes.filter((b) => !b.isSpeedline && b.area >= 1200);
  const corePool = substantial.length > 0 ? substantial : allBoxes;

  const weightedMedian = (vals: Array<{ v: number; w: number }>): number => {
    const sorted = [...vals].sort((a, b) => a.v - b.v);
    const totalW = sorted.reduce((s, it) => s + it.w, 0);
    if (totalW <= 0) return sorted[Math.floor(sorted.length / 2)].v;
    let acc = 0;
    for (const it of sorted) {
      acc += it.w;
      if (acc >= totalW * 0.5) return it.v;
    }
    return sorted[sorted.length - 1].v;
  };

  const coreCx = weightedMedian(corePool.map((b) => ({ v: b.cx, w: b.area })));
  const coreCy = weightedMedian(corePool.map((b) => ({ v: b.cy, w: b.area })));

  // Reject speedlines, off-screen entry frames (> 680px horizontally / > 420px vertically),
  // and tiny distant particle motes
  const clustered = corePool.filter((b) => {
    const dx = Math.abs(b.cx - coreCx);
    const dy = Math.abs(b.cy - coreCy);
    if (dx > 680 || dy > 420) return false;
    if (b.area < 1600 && Math.hypot(dx, dy) > 320) return false;
    return true;
  });

  const finalBoxes = clustered.length > 0 ? clustered : corePool;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of finalBoxes) {
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }

  const fMinX = Math.round(minX);
  const fMinY = Math.round(minY);
  const fMaxX = Math.round(maxX);
  const fMaxY = Math.round(maxY);
  const focalW = fMaxX - fMinX;
  const focalH = fMaxY - fMinY;

  const useFourByThree =
    focalW > 1420 || focalH > 820 || Math.abs(coreCy) > 520;

  return {
    referenceViewport: useFourByThree
      ? { width: 1600, height: 1200 }
      : { width: 1334, height: 750 },
    focalBounds: {
      minX: fMinX,
      minY: fMinY,
      maxX: fMaxX,
      maxY: fMaxY,
    },
  };
}

/**
 * Summarizes Spine slot blend modes (`additive`, `screen`, `multiply`, `normal`) used by
 * a skeleton (or specifically by the active slots inside a given animation).
 */
export function detectSkeletonBlendModes(
  skeleton: SpineSkeleton | null | undefined,
  animName?: string
): SkeletonBlendSummary {
  const counts = new Map<SpineBlendModeName, number>();
  const slots = skeleton?.slots || [];
  let activeSlotNames: Set<string> | null = null;
  if (animName && skeleton?.animations?.[animName]) {
    const anim = skeleton.animations[animName];
    const used = new Set<string>();
    for (const sName of Object.keys(anim.slots || {})) used.add(sName);
    if (used.size > 0) activeSlotNames = used;
  }

  const normalizeBlend = (raw?: string): SpineBlendModeName => {
    const low = (raw || '').trim().toLowerCase();
    if (low === 'additive' || low === 'add') return 'additive';
    if (low === 'screen') return 'screen';
    if (low === 'multiply') return 'multiply';
    return 'normal';
  };

  for (const s of slots) {
    if (activeSlotNames && !activeSlotNames.has(s.name)) continue;
    const b = normalizeBlend(s.blend);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  if (counts.size === 0 && activeSlotNames) {
    for (const s of slots) {
      const b = normalizeBlend(s.blend);
      counts.set(b, (counts.get(b) || 0) + 1);
    }
  }

  const ordered = Array.from(counts.keys());
  const nonNormal: SpineBlendModeName[] = ['additive', 'screen', 'multiply'];
  let primaryBlendMode: SpineBlendModeName = 'normal';
  let bestNonNormalCount = 0;
  for (const cand of nonNormal) {
    const c = counts.get(cand) || 0;
    if (c > bestNonNormalCount) {
      bestNonNormalCount = c;
      primaryBlendMode = cand;
    }
  }

  return {
    primaryBlendMode,
    blendModes: ordered.length > 0 ? ordered : ['normal'],
    usesAdditive: (counts.get('additive') || 0) > 0,
  };
}

function splitTopLevelCmdBlocks(raw: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let j = start; j < raw.length; j++) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      blocks.push(raw.slice(start));
      break;
    }
    blocks.push(raw.slice(start, end + 1));
    i = end + 1;
  }
  return blocks;
}

/**
 * Extracts all stage-direction, camera, screen-effect, movement, and combat-phase
 * choreography cues encoded in `@CMD` and marker events of a Spine animation.
 */
export function extractSpineChoreographyCues(
  skeleton: SpineSkeleton | null | undefined,
  animName: string
): SpineChoreographyCues {
  const cameraCues: SpineCameraCue[] = [];
  const screenCues: SpineScreenCue[] = [];
  const movementCues: SpineMovementCue[] = [];
  const phaseCues: SpinePhaseCue[] = [];
  if (!skeleton || !animName) {
    return { cameraCues, screenCues, movementCues, phaseCues };
  }

  const effectiveAnim = resolveEffectiveAnimationName(skeleton, animName);
  const animsToInspect =
    effectiveAnim !== animName
      ? [skeleton.animations?.[animName], skeleton.animations?.[effectiveAnim]]
      : [skeleton.animations?.[animName]];

  const seenCam = new Set<string>();
  const seenScreen = new Set<string>();
  const seenMove = new Set<string>();
  const seenPhase = new Set<string>();

  const parseTargetsList = (body: string): string[] | undefined => {
    const m = body.match(/targets\s*=\s*\[([^\]]*)\]/i);
    if (!m) return undefined;
    const arr = Array.from(m[1].matchAll(/["']([^"']+)["']/g))
      .map((x) => x[1].trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  };

  const parseNumArray = (body: string, field: string): number[] | undefined => {
    const m = body.match(new RegExp(`\\b${field}\\s*=\\s*\\[([^\\]]*)\\]`, 'i'));
    if (!m) return undefined;
    const nums = m[1]
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    return nums.length > 0 ? nums : undefined;
  };

  for (const anim of animsToInspect) {
    if (!anim?.events?.length) continue;
    for (const ev of anim.events) {
      const timeMs = Math.max(0, Math.round((ev.time || 0) * 1000));
      const evName = (ev.name || '').trim();
      const rawStr = (ev.string || '').trim();

      // Non-@CMD marker labels (e.g. label:a0, label:fim)
      if (evName && evName !== '@CMD') {
        if (evName.toLowerCase() === 'label' && rawStr) {
          const pk = `label::${timeMs}::${rawStr}`;
          if (!seenPhase.has(pk)) {
            seenPhase.add(pk);
            phaseCues.push({ timeMs, type: 'label', label: rawStr });
          }
        }
        continue;
      }

      if (!rawStr) continue;
      const blocks = splitTopLevelCmdBlocks(rawStr);
      if (blocks.length === 0 && /^[a-z0-9_]+$/i.test(rawStr)) {
        const pk = `label::${timeMs}::${rawStr}`;
        if (!seenPhase.has(pk)) {
          seenPhase.add(pk);
          phaseCues.push({ timeMs, type: 'label', label: rawStr });
        }
        continue;
      }

      for (const block of blocks) {
        const headMatch = block.match(/^\{([A-Za-z0-9_]+)(?::([\s\S]*))?\}?$/);
        if (!headMatch) continue;
        const tag = headMatch[1];
        const tagLow = tag.toLowerCase();
        const body = headMatch[2] || '';

        if (tagLow === 'camera') {
          const center = body.match(/\bcenter\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const scaleM = body.match(/\bscale\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const cue: SpineCameraCue = {
            timeMs,
            type: 'camera',
            ...(center ? { center } : {}),
            ...(scaleM ? { scale: Number(scaleM[1]) } : {}),
            ...(durM ? { durationFrames: Number(durM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenCam.has(dk)) {
            seenCam.add(dk);
            cameraCues.push(cue);
          }
        } else if (tagLow === 'rock') {
          const hM = body.match(/\bhstrength\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
          const vM = body.match(/\bvstrength\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
          const cue: SpineCameraCue = {
            timeMs,
            type: 'rock',
            ...(hM ? { hStrength: Number(hM[1]) } : {}),
            ...(vM ? { vStrength: Number(vM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenCam.has(dk)) {
            seenCam.add(dk);
            cameraCues.push(cue);
          }
        } else if (tagLow === 'flash') {
          const color = body.match(/\bcolor\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const alphaM = body.match(/\balpha\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const cue: SpineScreenCue = {
            timeMs,
            type: 'flash',
            ...(color ? { color } : {}),
            ...(alphaM ? { alpha: Number(alphaM[1]) } : {}),
            ...(durM ? { durationMs: Number(durM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'changebg' || tagLow === 'onlyparters' || tagLow === 'showall' || tagLow === 'showring') {
          const cue: SpineScreenCue = {
            timeMs,
            type: tagLow as 'changebg' | 'onlyparters' | 'showall' | 'showring',
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'scenetransform') {
          const colorMatrix = parseNumArray(body, 'color');
          const hbsc = parseNumArray(body, 'hbsc');
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const onlyBgM = body.match(/\bonlyBg\s*=\s*["']?(\d+|true|false)["']?/i);
          const cue: SpineScreenCue = {
            timeMs,
            type: 'scenetransform',
            ...(onlyBgM ? { onlyBg: onlyBgM[1] === '1' || onlyBgM[1].toLowerCase() === 'true' } : {}),
            ...(colorMatrix ? { colorMatrix } : {}),
            ...(hbsc ? { hbsc } : {}),
            ...(durM ? { durationMs: Number(durM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'transform') {
          const targets = parseTargetsList(body);
          const effectName = body.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const cue: SpineScreenCue = {
            timeMs,
            type: 'transform',
            ...(effectName ? { effectName } : {}),
            ...(targets ? { targets } : {}),
            ...(durM ? { durationMs: Number(durM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'showfeature') {
          const files: string[] = [];
          let mainFile = '';
          for (const om of block.matchAll(/\{([^{}]+)\}/g)) {
            const ob = om[1];
            const fm = ob.match(/\bfile\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
            if (!fm || fm.toLowerCase() === 'tongyongtexie') continue;
            files.push(fm);
            if (/\bmain\s*=\s*["']?1["']?/i.test(ob) || !mainFile) mainFile = fm;
          }
          const cue: SpineScreenCue = {
            timeMs,
            type: 'showfeature',
            ...(files.length > 0 ? { files } : {}),
            ...(mainFile ? { mainFile } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'hide') {
          const effectName = body.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const cleanupM = body.match(/\bcleanup\s*=\s*["']?(\d+|true|false)["']?/i);
          const cue: SpineScreenCue = {
            timeMs,
            type: 'hide',
            ...(effectName ? { effectName } : {}),
            ...(cleanupM ? { cleanup: cleanupM[1] === '1' || cleanupM[1].toLowerCase() === 'true' } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenScreen.has(dk)) {
            seenScreen.add(dk);
            screenCues.push(cue);
          }
        } else if (tagLow === 'move') {
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const destType = body.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const dispBlock = body.match(/\bdisp\s*=\s*\{([^}]*)\}/i)?.[1] || body;
          const dxM = dispBlock.match(/\bx\s*=\s*(-?\d+(?:\.\d+)?)/i);
          const dyM = dispBlock.match(/\by\s*=\s*(-?\d+(?:\.\d+)?)/i);
          const cue: SpineMovementCue = {
            timeMs,
            type: 'move',
            ...(durM ? { durationFrames: Number(durM[1]) } : {}),
            ...(destType ? { destType } : {}),
            ...(dxM ? { dispX: Number(dxM[1]) } : {}),
            ...(dyM ? { dispY: Number(dyM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenMove.has(dk)) {
            seenMove.add(dk);
            movementCues.push(cue);
          }
        } else if (tagLow === 'play') {
          const name = body.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const loopM = body.match(/\bloop\s*=\s*["']?(\d+|true|false)["']?/i);
          const cue: SpineMovementCue = {
            timeMs,
            type: 'play',
            ...(name ? { animName: name } : {}),
            ...(loopM ? { loop: loopM[1] === '1' || loopM[1].toLowerCase() === 'true' } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenMove.has(dk)) {
            seenMove.add(dk);
            movementCues.push(cue);
          }
        } else if (tagLow === 'attach') {
          const bone = body.match(/\bbone\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const apyM = body.match(/\bapy\s*=\s*["']?(-?\d+(?:\.\d+)?)["']?/i);
          const hurtAnimM = body.match(/\bAnim\s*=\s*\{\s*([A-Za-z0-9_]+)\s*=/i);
          const cue: SpineMovementCue = {
            timeMs,
            type: 'attach',
            ...(bone ? { bone } : {}),
            ...(apyM ? { apy: Number(apyM[1]) } : {}),
            ...(hurtAnimM ? { hurtAnim: hurtAnimM[1] } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenMove.has(dk)) {
            seenMove.add(dk);
            movementCues.push(cue);
          }
        } else if (tagLow === 'detach') {
          const bone = body.match(/\bbone\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const durM = body.match(/\bduration\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i);
          const dirM = body.match(/\bdirection\s*=\s*["']?(-?\d+)["']?/i);
          const cue: SpineMovementCue = {
            timeMs,
            type: 'detach',
            ...(bone ? { bone } : {}),
            ...(durM ? { durationFrames: Number(durM[1]) } : {}),
            ...(dirM ? { direction: Number(dirM[1]) } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenMove.has(dk)) {
            seenMove.add(dk);
            movementCues.push(cue);
          }
        } else if (tagLow === 'onebyone') {
          const action = body.match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
          const targets = parseTargetsList(body);
          const cue: SpineMovementCue = {
            timeMs,
            type: 'onebyone',
            ...(action ? { animName: action } : {}),
            ...(targets ? { targets } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenMove.has(dk)) {
            seenMove.add(dk);
            movementCues.push(cue);
          }
        } else if (
          tagLow === 'preact' ||
          tagLow === 'next' ||
          tagLow === 'postact' ||
          tagLow === 'pretargetact' ||
          tagLow === 'posttargetact' ||
          tagLow === 'end' ||
          tagLow === 'call' ||
          tagLow === 'pause' ||
          tagLow === 'plano'
        ) {
          const planoM = tagLow === 'plano' ? body.match(/\bid\s*=\s*["']?([^"',\s}]+)["']?/i) : null;
          const cue: SpinePhaseCue = {
            timeMs,
            type: tagLow as SpinePhaseCue['type'],
            ...(planoM?.[1] ? { planoId: /^\d+$/.test(planoM[1]) ? Number(planoM[1]) : planoM[1] } : {}),
          };
          const dk = JSON.stringify(cue);
          if (!seenPhase.has(dk)) {
            seenPhase.add(dk);
            phaseCues.push(cue);
          }
        }
      }
    }
  }

  cameraCues.sort((a, b) => a.timeMs - b.timeMs);
  screenCues.sort((a, b) => a.timeMs - b.timeMs);
  movementCues.sort((a, b) => a.timeMs - b.timeMs);
  phaseCues.sort((a, b) => a.timeMs - b.timeMs);

  return { cameraCues, screenCues, movementCues, phaseCues };
}




