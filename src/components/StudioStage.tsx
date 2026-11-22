import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  Clapperboard,
  Crosshair,
  Download,
  Film,
  Grid,
  Layers,
  Maximize2,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AtlasPage,
  AtlasRegion,
  CompositeSpineLayer,
  NinjaEntry,
  NinjaMediaProfile,
  SlicedFrame,
  SpineAudioEventRef,
  SpineCommandEffectRef,
  SpineSkeleton,
  SpineVideoEventRef,
  SpriteRegionSource,
} from '../types/sprite';
import {
  buildRegionSpriteMap,
  computeCompositeAnimationWorldBounds,
  computeNativeExportCellSize,
  downloadBlob,
  downloadDataUrl,
  exportAnimationGif,
  exportAnimationStripPng,
  exportFramesAsZip,
  extractSpineAudioRefs,
  extractSpineEffectRefs,
  extractSpineVideoRefs,
  getAnimationDuration,
  getCompositeAnimationDuration,
  hasVisibleAnimationContent,
  loadImageElement,
  parseAtlas,
  renderSpineFrameToCanvas,
  resolveEffectiveAnimationName,
  sliceAtlasRegions,
  type RenderSpineFrameOptions,
} from '../utils/atlasParser';
import { audioCuePlayer } from '../utils/audioCuePlayer';
import {
  buildCharacterInstructionsJson,
  collectCharacterEffectPlan,
  collectCharacterSkillIconFiles,
  exportCompleteCharacterZip,
  getOrderedSkillIconTargets,
  sanitizePathSegment,
  type EffectIncludeScope,
} from '../utils/completeCharacterExporter';
import {
  fetchNinjaBundle,
  fetchNinjaMediaProfile,
  resolveAssetFetchUrl,
  resolveMediaPlayUrl,
  resolveMediaSoundUrl,
  resolveMediaVideoUrl,
} from '../utils/remoteClient';
import { assembleStreamingZipBlob, computeCrc32, type StreamingZipEntry } from '../utils/streamingZip';

interface LoadedEffectBundle {
  skeleton: SpineSkeleton;
  regionCanvasMap: Map<string, SpriteRegionSource>;
}

const MAX_EFFECT_BUNDLE_CACHE = 24;
const effectBundleCache = new Map<string, Promise<LoadedEffectBundle | null>>();

async function loadEffectImageWithRetry(src: string): Promise<HTMLImageElement> {
  try {
    return await loadImageElement(src);
  } catch {
    await new Promise((r) => setTimeout(r, 350));
    return await loadImageElement(src);
  }
}

function loadEffectBundle(
  baseAtlasUrl: string,
  spineId: string,
  explicitUrls?: { atlasUrl: string; skeletonUrl: string }
): Promise<LoadedEffectBundle | null> {
  let atlasUrl: string;
  let skeletonUrl: string;
  try {
    atlasUrl = explicitUrls?.atlasUrl || new URL(`${spineId}.atlas`, baseAtlasUrl).toString();
    skeletonUrl = explicitUrls?.skeletonUrl || new URL(`${spineId}.json`, baseAtlasUrl).toString();
  } catch {
    return Promise.resolve(null);
  }

  const cacheKey = atlasUrl;
  const cached = effectBundleCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const data = await fetchNinjaBundle(atlasUrl, skeletonUrl);
      if (!data.skeleton) return null;
      const parsedPages = parseAtlas(data.atlasText);
      const loadedImgs: Record<string, HTMLImageElement> = {};
      await Promise.allSettled(
        Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
          loadedImgs[pageName] = await loadEffectImageWithRetry(proxyUrl);
        })
      );
      const canvasMap = buildRegionSpriteMap(parsedPages, loadedImgs);
      if (canvasMap.size === 0) {
        effectBundleCache.delete(cacheKey);
        return null;
      }
      return {
        skeleton: data.skeleton,
        regionCanvasMap: canvasMap,
      };
    } catch {
      effectBundleCache.delete(cacheKey);
      return null;
    }
  })();

  if (effectBundleCache.size >= MAX_EFFECT_BUNDLE_CACHE) {
    const oldest = effectBundleCache.keys().next().value;
    if (oldest) effectBundleCache.delete(oldest);
  }
  effectBundleCache.set(cacheKey, promise);
  return promise;
}

interface StudioStageProps {
  ninja: NinjaEntry | null;
  openCompleteExportSignal?: number;
  onBackToCatalog: () => void;
  onLoadedFramesChange: (payload: {
    ninjaId: string;
    frames: SlicedFrame[];
    atlasText: string;
    skeleton: SpineSkeleton | null;
  } | null) => void;
}

type StageMode = 'player' | 'frames' | 'sheet';
type BgStyle = 'checker' | 'dark' | 'light' | 'chroma';

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

const DEFAULT_ANIM_PT_LABELS: Record<string, string> = {
  idle: 'Parado (Combate)',
  attack: 'Ataque Normal',
  skill: 'Habilidade',
  uniqueskill: 'Esotérica / Ultimate',
  superuniqueskill: 'Super Esotérica',
  chase1: 'Perseguição 1',
  chase2: 'Perseguição 2',
  chase3: 'Perseguição 3',
  gatilho1: 'Gatilho 1',
  gatilho2: 'Gatilho 2',
  run: 'Corrida',
  win: 'Vitória',
  hurt1: 'Dano',
  die: 'Derrota',
};

const PLAYER_STAGE_RENDER_OPTIONS: RenderSpineFrameOptions = {
  fillRatio: 0.54,
  maxAutoFitScale: 1.0,
  followFramePose: true,
};

function clampPlayerPan(x: number, y: number, zoomLevel: number): { x: number; y: number } {
  const maxX = Math.round(320 * Math.max(1, zoomLevel));
  const maxY = Math.round(210 * Math.max(1, zoomLevel));
  return {
    x: Math.max(-maxX, Math.min(maxX, Math.round(x))),
    y: Math.max(-maxY, Math.min(maxY, Math.round(y))),
  };
}

export function StudioStage({
  ninja,
  openCompleteExportSignal = 0,
  onBackToCatalog,
  onLoadedFramesChange,
}: StudioStageProps) {
  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [bgStyle, setBgStyle] = useState<BgStyle>('checker');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [autoFit, setAutoFit] = useState(true);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [atlasText, setAtlasText] = useState('');
  const [pages, setPages] = useState<AtlasPage[]>([]);
  const [pageUrls, setPageUrls] = useState<Record<string, string>>({});
  const [pageImages, setPageImages] = useState<Record<string, HTMLImageElement>>({});
  const [skeleton, setSkeleton] = useState<SpineSkeleton | null>(null);
  const [frames, setFrames] = useState<SlicedFrame[]>([]);
  const [regionCanvasMap, setRegionCanvasMap] = useState<Map<string, SpriteRegionSource>>(
    () => new Map()
  );

  // Player state
  const [selectedAnim, setSelectedAnim] = useState('idle');
  const [animFilter, setAnimFilter] = useState('');
  const [frameFilter, setFrameFilter] = useState('');
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [showAtlasBoxes, setShowAtlasBoxes] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<AtlasRegion | null>(null);
  const [exportingAnim, setExportingAnim] = useState(false);
  const [gifProgress, setGifProgress] = useState<number | null>(null);
  const [gifBg, setGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>('transparent');

  // Complete character export modal state
  const [showCompleteExportModal, setShowCompleteExportModal] = useState(false);
  const [completeEffectScope, setCompleteEffectScope] = useState<EffectIncludeScope>('powers');
  const [completeIncludeOriginals, setCompleteIncludeOriginals] = useState(true);
  const [completeIncludeEffects, setCompleteIncludeEffects] = useState(true);
  const [completeIncludeAnimPngs, setCompleteIncludeAnimPngs] = useState(true);
  const [completeIncludeAnimGifs, setCompleteIncludeAnimGifs] = useState(true);
  const [completeIncludePassiveAura, setCompleteIncludePassiveAura] = useState(true);
  const [completeIncludeVideosAndAudio, setCompleteIncludeVideosAndAudio] = useState(true);
  const [completeIncludeSkillIcons, setCompleteIncludeSkillIcons] = useState(true);
  const [downloadingSkillIconsZip, setDownloadingSkillIconsZip] = useState(false);
  const [downloadingBaseFramesZip, setDownloadingBaseFramesZip] = useState(false);
  const [completeGifBg, setCompleteGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>(
    'transparent'
  );
  const [completeExportProgress, setCompleteExportProgress] = useState<{
    phase: string;
    message: string;
    percent: number;
  } | null>(null);
  const [completeExportError, setCompleteExportError] = useState<string | null>(null);
  const completeExportAbortRef = useRef<AbortController | null>(null);

  const [effectMode, setEffectMode] = useState<'powers' | 'all' | 'base'>('powers');
  const [compositeLayers, setCompositeLayers] = useState<CompositeSpineLayer[]>([]);
  const [loadingEffects, setLoadingEffects] = useState(false);
  const [effectLoadError, setEffectLoadError] = useState<string | null>(null);

  // Media profile (skills, passive aura, ultimate MP4 videos, voices & SFX)
  const [mediaProfile, setMediaProfile] = useState<NinjaMediaProfile | null>(null);
  const [passiveAuraBundle, setPassiveAuraBundle] = useState<LoadedEffectBundle | null>(null);
  const [loadingPassiveAura, setLoadingPassiveAura] = useState(false);
  const [showPassiveAura, setShowPassiveAura] = useState(true);
  const [passiveAuraPhase, setPassiveAuraPhase] = useState<'loop' | 'intro' | 'outro'>('loop');

  // Audio & Ultimate MP4 cutscene state
  const [soundMuted, setSoundMuted] = useState(false);
  const [soundVolume, setSoundVolume] = useState(0.85);
  const [playingVoiceKey, setPlayingVoiceKey] = useState<string | null>(null);
  const [enableVideoCutscene, setEnableVideoCutscene] = useState(true);
  const [activeVideoOverlay, setActiveVideoOverlay] = useState<{
    playUrl: string;
    rawUrl: string;
    label: string;
    key: string;
    resumePlaying: boolean;
  } | null>(null);
  const [videoAutoplayMuted, setVideoAutoplayMuted] = useState(false);

  const [playerDetached, setPlayerDetached] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);

  const playerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerBoxRef = useRef<HTMLDivElement | null>(null);
  const savedScrollYRef = useRef<number | null>(null);
  const animTimeRef = useRef(0);
  const prevAnimTimeRef = useRef(-1);
  const videoTriggeredCycleRef = useRef(false);
  const videoElemRef = useRef<HTMLVideoElement | null>(null);

  const openDetachedPlayer = () => {
    if (!playerDetached) {
      savedScrollYRef.current = window.scrollY;
      if (playerBoxRef.current) {
        const h = playerBoxRef.current.getBoundingClientRect().height;
        if (h > 0) setDockHeight(h);
      }
    }
    setPlayerDetached(true);
  };

  const closeDetachedPlayer = () => {
    setPlayerDetached(false);
  };

  const applyZoom = (updater: (prev: number) => number) => {
    setZoom((prevZoom) => {
      const nextZoom = Math.max(0.2, Math.min(6, Number(updater(prevZoom).toFixed(2))));
      if (nextZoom !== prevZoom && prevZoom > 0) {
        const ratio = nextZoom / prevZoom;
        setPan((prevPan) => {
          if (prevPan.x === 0 && prevPan.y === 0) return prevPan;
          return clampPlayerPan(prevPan.x * ratio, prevPan.y * ratio, nextZoom);
        });
      }
      return nextZoom;
    });
  };

  useEffect(() => {
    if (!ninja) {
      onLoadedFramesChange(null);
      return;
    }

    let cancelled = false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    setLoading(true);
    setError(null);
    setSelectedRegion(null);
    setCurrentTime(0);
    setAutoFit(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    savedScrollYRef.current = null;
    setDockHeight(0);
    setPlayerDetached(false);
    setShowCompleteExportModal(false);
    setCompleteExportProgress(null);
    setCompleteExportError(null);
    setEffectMode('powers');
    setCompositeLayers([]);
    setMediaProfile(null);
    setPassiveAuraBundle(null);
    setShowPassiveAura(true);
    setPassiveAuraPhase('loop');
    setActiveVideoOverlay(null);
    setVideoAutoplayMuted(false);
    setPlayingVoiceKey(null);
    audioCuePlayer.stopAll();
    animTimeRef.current = 0;
    prevAnimTimeRef.current = -1;
    videoTriggeredCycleRef.current = false;

    async function loadBundle() {
      if (!ninja) return;
      try {
        const data = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl);
        if (cancelled) return;

        const parsedPages = parseAtlas(data.atlasText);
        const loadedImgs: Record<string, HTMLImageElement> = {};
        await Promise.all(
          Object.entries(data.pageUrls).map(async ([pageName, proxyUrl]) => {
            loadedImgs[pageName] = await loadImageElement(proxyUrl);
          })
        );
        if (cancelled) return;

        const sliced = sliceAtlasRegions(parsedPages, loadedImgs);
        const canvasMap = buildRegionSpriteMap(parsedPages, loadedImgs);

        const availableAnims = Object.keys(data.skeleton?.animations || {});
        const idleAnim = availableAnims.find((a) => a.toLowerCase() === 'idle');
        const visibleIdle =
          idleAnim && hasVisibleAnimationContent(data.skeleton, idleAnim) ? idleAnim : undefined;
        const firstVisiblePriority = PRIORITY_ANIM_ORDER.find(
          (a) => availableAnims.includes(a) && hasVisibleAnimationContent(data.skeleton, a)
        );
        const firstVisibleAny = availableAnims.find((a) =>
          hasVisibleAnimationContent(data.skeleton, a)
        );
        const defaultAnim =
          visibleIdle ||
          firstVisiblePriority ||
          firstVisibleAny ||
          idleAnim ||
          PRIORITY_ANIM_ORDER.find((a) => availableAnims.includes(a)) ||
          availableAnims[0] ||
          '';

        setAtlasText(data.atlasText);
        setPages(parsedPages);
        setPageUrls(data.pageUrls);
        setPageImages(loadedImgs);
        setSkeleton(data.skeleton);
        setFrames(sliced);
        setRegionCanvasMap(canvasMap);
        if (defaultAnim) {
          setSelectedAnim(defaultAnim);
          setStageMode('player');
          setIsPlaying(true);
          setCurrentTime(0);
          animTimeRef.current = 0;
        } else {
          setStageMode('frames');
        }

        onLoadedFramesChange({
          ninjaId: ninja.id,
          frames: sliced,
          atlasText: data.atlasText,
          skeleton: data.skeleton,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar ninja.');
          onLoadedFramesChange(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadBundle();
    return () => {
      cancelled = true;
    };
  }, [ninja, onLoadedFramesChange]);

  const animNames = useMemo(() => {
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
  }, [skeleton]);

  // Exit detached overlay if user leaves player mode
  useEffect(() => {
    if (stageMode !== 'player') {
      setPlayerDetached(false);
    }
  }, [stageMode]);

  // Lock background scroll, allow Escape key to dismiss, and restore scrollY on close
  useEffect(() => {
    if (!playerDetached) {
      const targetY = savedScrollYRef.current;
      if (targetY !== null) {
        savedScrollYRef.current = null;
        window.scrollTo({ top: targetY, behavior: 'auto' });
        const rafId = requestAnimationFrame(() => {
          window.scrollTo({ top: targetY, behavior: 'auto' });
        });
        return () => cancelAnimationFrame(rafId);
      }
      return;
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDetachedPlayer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [playerDetached]);

  useEffect(() => {
    if (openCompleteExportSignal > 0 && ninja && !loading && !error) {
      setShowCompleteExportModal(true);
    }
  }, [openCompleteExportSignal, ninja, loading, error]);

  const completeEffectPlan = useMemo(
    () => collectCharacterEffectPlan(skeleton, completeEffectScope),
    [skeleton, completeEffectScope]
  );

  const effectiveAnim = useMemo(() => {
    if (!skeleton || !selectedAnim) return selectedAnim;
    return resolveEffectiveAnimationName(skeleton, selectedAnim);
  }, [skeleton, selectedAnim]);

  // Fetch character media profile (PT skill names, passive idle aura, MP4 videos, voices & SFX map)
  useEffect(() => {
    if (!ninja || !skeleton) {
      setMediaProfile(null);
      return;
    }
    let cancelled = false;
    void fetchNinjaMediaProfile(ninja, skeleton).then((profile) => {
      if (!cancelled) setMediaProfile(profile);
    });
    return () => {
      cancelled = true;
    };
  }, [ninja, skeleton]);

  // Load passive idle aura Spine bundle (e.g., Sasuke Susano'o skeletal ribcage noe_ZUOZHUXZbati)
  useEffect(() => {
    const aura = mediaProfile?.passiveAura;
    if (!ninja || !aura) {
      setPassiveAuraBundle(null);
      setLoadingPassiveAura(false);
      return;
    }
    let cancelled = false;
    setLoadingPassiveAura(true);
    void loadEffectBundle(ninja.atlasUrl, aura.id, {
      atlasUrl: aura.atlasUrl,
      skeletonUrl: aura.skeletonUrl,
    })
      .then((bundle) => {
        if (!cancelled) setPassiveAuraBundle(bundle);
      })
      .finally(() => {
        if (!cancelled) setLoadingPassiveAura(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ninja, mediaProfile]);

  // Automatically show passive aura when on idle (user can also toggle on/off for any animation)
  useEffect(() => {
    if (mediaProfile?.passiveAura) {
      setShowPassiveAura(effectiveAnim.toLowerCase() === 'idle');
      setPassiveAuraPhase('loop');
    } else {
      setShowPassiveAura(false);
    }
  }, [effectiveAnim, mediaProfile?.passiveAura]);

  const animEffectMap = useMemo(() => {
    const map = new Map<string, SpineCommandEffectRef[]>();
    if (!skeleton) return map;
    for (const animName of animNames) {
      map.set(animName, extractSpineEffectRefs(skeleton, animName));
    }
    return map;
  }, [skeleton, animNames]);

  const animAudioMap = useMemo(() => {
    const map = new Map<string, SpineAudioEventRef[]>();
    if (!skeleton) return map;
    for (const animName of animNames) {
      map.set(animName, extractSpineAudioRefs(skeleton, animName));
    }
    return map;
  }, [skeleton, animNames]);

  const animVideoMap = useMemo(() => {
    const map = new Map<string, SpineVideoEventRef[]>();
    if (!skeleton) return map;
    const ultimateVideos = (mediaProfile?.videos || []).filter((v) => v.kind === 'ultimate');
    for (const animName of animNames) {
      const refs = [...extractSpineVideoRefs(skeleton, animName)];
      const seenKeys = new Set(refs.map((r) => r.resolvedName.toLowerCase()));
      const eff = resolveEffectiveAnimationName(skeleton, animName);

      for (const vid of ultimateVideos) {
        if (!vid.animName) continue;
        const vidAnimLow = vid.animName.toLowerCase();
        const matchesAnim =
          vidAnimLow === animName.toLowerCase() || vidAnimLow === eff.toLowerCase();
        if (!matchesAnim) continue;
        if (seenKeys.has(vid.key.toLowerCase())) continue;
        seenKeys.add(vid.key.toLowerCase());
        refs.push({
          source: vid.key,
          resolvedName: vid.key,
          time: typeof vid.startTime === 'number' ? vid.startTime : 0.25,
          careforward: false,
          layer: 'fg',
          rawCommand: `{HERO_VIDEO:source="${vid.key}"}`,
        });
      }

      map.set(animName, refs);
    }
    return map;
  }, [skeleton, animNames, mediaProfile?.videos]);

  const rawEffectRefs = useMemo(
    () => animEffectMap.get(selectedAnim) || [],
    [animEffectMap, selectedAnim]
  );

  const activeAudioRefs = useMemo(
    () => animAudioMap.get(selectedAnim) || [],
    [animAudioMap, selectedAnim]
  );

  const activeVideoRefs = useMemo(
    () => animVideoMap.get(selectedAnim) || [],
    [animVideoMap, selectedAnim]
  );

  const hasSelfPowers = useMemo(
    () => rawEffectRefs.some((r) => r.isSelfOrScreen),
    [rawEffectRefs]
  );
  const hasImpactEffects = useMemo(
    () => rawEffectRefs.some((r) => !r.isSelfOrScreen),
    [rawEffectRefs]
  );

  // Build passive aura composite layers when enabled
  const passiveAuraLayers = useMemo<CompositeSpineLayer[]>(() => {
    const aura = mediaProfile?.passiveAura;
    if (!aura || !passiveAuraBundle || !showPassiveAura) return [];
    const avail = Object.keys(passiveAuraBundle.skeleton.animations || {});
    const layers: CompositeSpineLayer[] = [];
    for (const layerDef of aura.layers) {
      const wanted =
        passiveAuraPhase === 'intro'
          ? layerDef.introAnim || layerDef.loopAnim
          : passiveAuraPhase === 'outro'
          ? layerDef.outroAnim || layerDef.loopAnim
          : layerDef.loopAnim;
      const target =
        avail.find((a) => a === wanted) ||
        avail.find((a) => a.toLowerCase() === wanted.toLowerCase()) ||
        avail[0];
      if (!target) continue;
      layers.push({
        spineId: aura.id,
        skeleton: passiveAuraBundle.skeleton,
        animName: target,
        regionCanvasMap: passiveAuraBundle.regionCanvasMap,
        startTime: 0,
        duration: getAnimationDuration(passiveAuraBundle.skeleton, target),
        layer: layerDef.layer,
        loop: passiveAuraPhase === 'loop',
      });
    }
    return layers;
  }, [mediaProfile?.passiveAura, passiveAuraBundle, showPassiveAura, passiveAuraPhase]);

  const allCompositeLayers = useMemo<CompositeSpineLayer[]>(
    () =>
      passiveAuraLayers.length > 0
        ? [...passiveAuraLayers, ...compositeLayers]
        : compositeLayers,
    [passiveAuraLayers, compositeLayers]
  );

  // Load companion Spine power/particle bundles for the selected animation
  useEffect(() => {
    if (!ninja || !skeleton || !selectedAnim || effectMode === 'base' || rawEffectRefs.length === 0) {
      setCompositeLayers([]);
      setLoadingEffects(false);
      setEffectLoadError(null);
      return;
    }

    const activeRefs =
      effectMode === 'all'
        ? rawEffectRefs
        : rawEffectRefs.filter((r) => r.isSelfOrScreen);

    if (activeRefs.length === 0) {
      setCompositeLayers([]);
      setLoadingEffects(false);
      setEffectLoadError(null);
      return;
    }

    let cancelled = false;
    setCompositeLayers([]);
    setLoadingEffects(true);
    setEffectLoadError(null);

    const uniqueSpineIds = Array.from(new Set(activeRefs.map((r) => r.spineId)));
    Promise.all(
      uniqueSpineIds.map(async (id) => [id, await loadEffectBundle(ninja.atlasUrl, id)] as const)
    )
      .then((entries) => {
        if (cancelled) return;
        const bundleMap = new Map<string, LoadedEffectBundle>();
        for (const [id, bundle] of entries) {
          if (bundle) bundleMap.set(id, bundle);
        }

        const builtLayers: CompositeSpineLayer[] = [];
        for (const ref of activeRefs) {
          const bundle = bundleMap.get(ref.spineId);
          if (!bundle) continue;
          const available = Object.keys(bundle.skeleton.animations || {});
          const refLower = ref.animName.trim().toLowerCase();
          const targetAnim =
            available.find((a) => a === ref.animName) ||
            available.find((a) => a.trim().toLowerCase() === refLower) ||
            available[0];
          if (!targetAnim) continue;

          builtLayers.push({
            spineId: ref.spineId,
            skeleton: bundle.skeleton,
            animName: targetAnim,
            regionCanvasMap: bundle.regionCanvasMap,
            startTime: ref.startTime,
            duration: getAnimationDuration(bundle.skeleton, targetAnim),
            layer: ref.layer,
            loop: ref.loop,
          });
        }
        setCompositeLayers(builtLayers);
        if (builtLayers.length === 0) {
          setEffectLoadError('Partículas indisponíveis no momento');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEffects(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ninja, skeleton, selectedAnim, effectMode, rawEffectRefs]);

  // Preload audio cues for the currently selected animation
  useEffect(() => {
    if (!ninja || activeAudioRefs.length === 0) return;
    const urls = activeAudioRefs
      .map((ref) => resolveMediaSoundUrl(ref.soundName, mediaProfile, ninja.atlasUrl))
      .filter((u): u is string => Boolean(u))
      .map((u) => resolveMediaPlayUrl(u))
      .filter((u): u is string => Boolean(u));
    audioCuePlayer.preloadAudioUrls(urls);
  }, [ninja, activeAudioRefs, mediaProfile]);

  const startVideoAutoplay = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video || video.ended) return;
      video.playsInline = true;
      video.volume = soundVolume;
      video.muted = soundMuted;
      setVideoAutoplayMuted(false);
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          if (!video.muted) {
            video.muted = true;
            setVideoAutoplayMuted(true);
            void video.play().catch(() => {});
          }
        });
      }
    },
    [soundMuted, soundVolume]
  );

  useEffect(() => {
    if (!activeVideoOverlay) {
      setVideoAutoplayMuted(false);
      return;
    }
    const video = videoElemRef.current;
    if (!video) return;
    startVideoAutoplay(video);
  }, [activeVideoOverlay, startVideoAutoplay]);

  // Keep active audio elements in sync with volume/mute controls & clean up on unmount
  useEffect(() => {
    if (soundMuted) {
      audioCuePlayer.stopAll();
      setPlayingVoiceKey(null);
    } else {
      audioCuePlayer.setVolume(soundVolume);
    }
    if (videoElemRef.current) {
      videoElemRef.current.muted = soundMuted || videoAutoplayMuted;
      videoElemRef.current.volume = soundVolume;
    }
  }, [soundMuted, soundVolume, videoAutoplayMuted]);

  useEffect(() => {
    return () => {
      audioCuePlayer.stopAll();
    };
  }, []);

  const getAnimDisplayMeta = (animName: string) => {
    const eff = skeleton ? resolveEffectiveAnimationName(skeleton, animName) : animName;
    const skill =
      mediaProfile?.skills?.[animName] ||
      mediaProfile?.skills?.[animName.toLowerCase()] ||
      mediaProfile?.skills?.[eff] ||
      mediaProfile?.skills?.[eff.toLowerCase()];
    if (skill) {
      return {
        label: `${skill.slotLabel} · ${skill.name}`,
        shortLabel: skill.name,
        slotLabel: skill.slotLabel,
        iconUrl: skill.iconUrl,
        desc: skill.desc,
      };
    }
    const fallback =
      DEFAULT_ANIM_PT_LABELS[animName.toLowerCase()] ||
      DEFAULT_ANIM_PT_LABELS[eff.toLowerCase()];
    return {
      label: fallback || animName,
      shortLabel: fallback || '',
      slotLabel: '',
      iconUrl: undefined as string | undefined,
      desc: undefined as string | undefined,
    };
  };

  const orderedSkillList = useMemo(() => {
    const skillsMap = mediaProfile?.skills || {};
    const order = ['attack', 'skill', 'UniqueSkill', 'chase1', 'chase2', 'chase3'];
    const result: Array<{
      key: string;
      animKey?: string;
      slotLabel: string;
      name: string;
      desc?: string;
      iconUrl?: string;
      isPassive: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const k of order) {
      const sk = skillsMap[k];
      if (!sk) continue;
      seen.add(k);
      result.push({
        key: `active_${k}`,
        animKey: sk.animKey,
        slotLabel: sk.slotLabel,
        name: sk.name,
        desc: sk.desc,
        iconUrl: sk.iconUrl,
        isPassive: false,
      });
    }
    for (const [k, sk] of Object.entries(skillsMap)) {
      if (seen.has(k) || !sk) continue;
      result.push({
        key: `active_${k}`,
        animKey: sk.animKey,
        slotLabel: sk.slotLabel,
        name: sk.name,
        desc: sk.desc,
        iconUrl: sk.iconUrl,
        isPassive: false,
      });
    }
    for (const p of mediaProfile?.passives || []) {
      result.push({
        key: `passive_${p.id}`,
        slotLabel: 'Passiva',
        name: p.name,
        desc: p.desc,
        iconUrl: p.iconUrl,
        isPassive: true,
      });
    }
    return result;
  }, [mediaProfile]);

  const skillIconCount = useMemo(
    () => getOrderedSkillIconTargets(mediaProfile).length,
    [mediaProfile]
  );

  const selectedAnimMeta = getAnimDisplayMeta(selectedAnim);

  const filteredAnimNames = useMemo(() => {
    const q = animFilter.trim().toLowerCase();
    if (!q) return animNames;
    return animNames.filter((a) => {
      if (a.toLowerCase().includes(q)) return true;
      const eff = skeleton ? resolveEffectiveAnimationName(skeleton, a) : a;
      const skill =
        mediaProfile?.skills?.[a] ||
        mediaProfile?.skills?.[a.toLowerCase()] ||
        mediaProfile?.skills?.[eff] ||
        mediaProfile?.skills?.[eff.toLowerCase()];
      const fallback = DEFAULT_ANIM_PT_LABELS[a.toLowerCase()] || '';
      return (
        (skill && `${skill.slotLabel} ${skill.name}`.toLowerCase().includes(q)) ||
        fallback.toLowerCase().includes(q)
      );
    });
  }, [animNames, animFilter, mediaProfile?.skills, skeleton]);

  const filteredFrames = useMemo(() => {
    const q = frameFilter.trim().toLowerCase();
    return q ? frames.filter((f) => f.name.toLowerCase().includes(q)) : frames;
  }, [frames, frameFilter]);

  const baseDuration = useMemo(() => {
    if (!skeleton || !effectiveAnim) return 0;
    return getAnimationDuration(skeleton, effectiveAnim);
  }, [skeleton, effectiveAnim]);

  const duration = useMemo(
    () => getCompositeAnimationDuration(baseDuration, allCompositeLayers),
    [baseDuration, allCompositeLayers]
  );

  const animWorldBounds = useMemo(() => {
    if (!skeleton || !effectiveAnim || regionCanvasMap.size === 0) return null;
    return computeCompositeAnimationWorldBounds(
      skeleton,
      effectiveAnim,
      regionCanvasMap,
      allCompositeLayers,
      24
    );
  }, [skeleton, effectiveAnim, regionCanvasMap, allCompositeLayers]);

  // Reset framing, audio & cutscene triggers cleanly when switching animations
  useEffect(() => {
    audioCuePlayer.stopAll();
    setActiveVideoOverlay(null);
    prevAnimTimeRef.current = -1;
    videoTriggeredCycleRef.current = false;
    if (autoFit) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [selectedAnim, autoFit]);

  // Animation loop (+ synchronized Spine SFX and Ultimate MP4 cutscene triggers)
  useEffect(() => {
    if (stageMode !== 'player' || !skeleton || !effectiveAnim || regionCanvasMap.size === 0) {
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();

    const drawCurrent = (t: number) => {
      const canvas = playerCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderSpineFrameToCanvas(
        ctx,
        canvas.width,
        canvas.height,
        skeleton,
        effectiveAnim,
        t,
        regionCanvasMap,
        zoom,
        pan.x,
        pan.y,
        autoFit ? animWorldBounds : null,
        allCompositeLayers,
        PLAYER_STAGE_RENDER_OPTIONS
      );
    };

    drawCurrent(animTimeRef.current);

    if (!isPlaying || duration <= 0 || activeVideoOverlay) {
      if (!isPlaying) {
        audioCuePlayer.stopAll();
      }
      return;
    }

    const resolveSoundPlayUrl = (soundName: string) => {
      if (!ninja) return null;
      const raw = resolveMediaSoundUrl(soundName, mediaProfile, ninja.atlasUrl);
      if (!raw) return null;
      const resolved = resolveMediaPlayUrl(raw);
      return resolved || null;
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      const prev = prevAnimTimeRef.current;
      const rawNext = animTimeRef.current + dt * speed;
      const loopWrapped = rawNext >= duration;
      const next = loopWrapped ? rawNext % duration : rawNext;

      if (loopWrapped) {
        videoTriggeredCycleRef.current = false;
      }

      if (activeAudioRefs.length > 0 && !soundMuted) {
        audioCuePlayer.triggerCuesInRange(
          activeAudioRefs,
          prev,
          next,
          loopWrapped,
          resolveSoundPlayUrl,
          soundVolume,
          soundMuted
        );
      }

      // Check synchronized ultimate MP4 cutscene event ({PLAYVEDIO:...})
      if (
        enableVideoCutscene &&
        activeVideoRefs.length > 0 &&
        !videoTriggeredCycleRef.current &&
        ninja
      ) {
        const triggerRef = activeVideoRefs.find((vr) =>
          prev < 0 ? vr.time <= next : !loopWrapped ? vr.time > prev && vr.time <= next : vr.time <= next
        );
        if (triggerRef) {
          const rawVideoUrl = resolveMediaVideoUrl(triggerRef, mediaProfile, ninja.atlasUrl);
          const playUrl = rawVideoUrl ? resolveMediaPlayUrl(rawVideoUrl) : '';
          if (rawVideoUrl && playUrl) {
            videoTriggeredCycleRef.current = true;
            animTimeRef.current = next;
            prevAnimTimeRef.current = next;
            setCurrentTime(next);
            drawCurrent(next);
            setActiveVideoOverlay({
              playUrl,
              rawUrl: rawVideoUrl,
              label: `Ultimate MP4 · ${triggerRef.resolvedName}`,
              key: triggerRef.resolvedName,
              resumePlaying: true,
            });
            return;
          }
        }
      }

      animTimeRef.current = next;
      prevAnimTimeRef.current = next;
      setCurrentTime(next);
      drawCurrent(next);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    stageMode,
    skeleton,
    effectiveAnim,
    regionCanvasMap,
    allCompositeLayers,
    isPlaying,
    speed,
    duration,
    zoom,
    pan,
    autoFit,
    animWorldBounds,
    loading,
    activeVideoOverlay,
    activeAudioRefs,
    activeVideoRefs,
    enableVideoCutscene,
    soundMuted,
    soundVolume,
    mediaProfile,
    ninja,
    playerDetached,
  ]);

  // Redraw when manually scrubbing while paused or if mobile GPU restores canvas context
  useEffect(() => {
    if (stageMode !== 'player' || !skeleton || !effectiveAnim || regionCanvasMap.size === 0) return;

    const redrawNow = () => {
      const canvas = playerCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        renderSpineFrameToCanvas(
          ctx,
          canvas.width,
          canvas.height,
          skeleton,
          effectiveAnim,
          animTimeRef.current,
          regionCanvasMap,
          zoom,
          pan.x,
          pan.y,
          autoFit ? animWorldBounds : null,
          allCompositeLayers,
          PLAYER_STAGE_RENDER_OPTIONS
        );
      }
    };

    if (!isPlaying) {
      animTimeRef.current = currentTime;
      prevAnimTimeRef.current = currentTime;
      redrawNow();
    }

    const canvasEl = playerCanvasRef.current;
    if (!canvasEl) return;
    canvasEl.addEventListener('contextrestored', redrawNow);
    return () => {
      canvasEl.removeEventListener('contextrestored', redrawNow);
    };
  }, [
    currentTime,
    isPlaying,
    stageMode,
    skeleton,
    effectiveAnim,
    regionCanvasMap,
    allCompositeLayers,
    zoom,
    pan,
    autoFit,
    animWorldBounds,
    playerDetached,
  ]);

  const bgClass =
    bgStyle === 'checker'
      ? 'sprite-checkerboard'
      : bgStyle === 'light'
      ? 'sprite-checkerboard-light'
      : bgStyle === 'chroma'
      ? 'bg-[#00B140]'
      : 'bg-[#090D14]';

  const handleDownloadCurrentCanvasFrame = () => {
    if (!ninja) return;
    if (skeleton && effectiveAnim) {
      const bounds =
        animWorldBounds ||
        computeCompositeAnimationWorldBounds(
          skeleton,
          effectiveAnim,
          regionCanvasMap,
          allCompositeLayers,
          24
        );
      const { width: cellW, height: cellH } = computeNativeExportCellSize(bounds, 2048);
      const offCanvas = document.createElement('canvas');
      offCanvas.width = cellW;
      offCanvas.height = cellH;
      const ctx = offCanvas.getContext('2d');
      if (ctx) {
        renderSpineFrameToCanvas(
          ctx,
          cellW,
          cellH,
          skeleton,
          effectiveAnim,
          currentTime,
          regionCanvasMap,
          1,
          0,
          0,
          bounds,
          allCompositeLayers
        );
        downloadDataUrl(
          offCanvas.toDataURL('image/png'),
          `${ninja.id}_${selectedAnim || 'frame'}_hq.png`
        );
        return;
      }
    }
    const canvas = playerCanvasRef.current;
    if (!canvas) return;
    downloadDataUrl(
      canvas.toDataURL('image/png'),
      `${ninja.id}_${selectedAnim || 'frame'}.png`
    );
  };

  const handleExportAnimStrip = () => {
    if (!skeleton || !effectiveAnim || !ninja) return;
    const res = exportAnimationStripPng(
      skeleton,
      effectiveAnim,
      regionCanvasMap,
      24,
      allCompositeLayers
    );
    const suffix = allCompositeLayers.length > 0 ? '_com_poderes' : '';
    downloadDataUrl(res.dataUrl, `${ninja.id}_${selectedAnim}${suffix}_strip_${res.frameCount}f.png`);
  };

  const handleExportAnimZip = async () => {
    if (!skeleton || !effectiveAnim || !ninja || duration <= 0) return;
    setExportingAnim(true);
    try {
      const fps = 24;
      const count = Math.max(1, Math.min(240, Math.round(duration * fps)));
      const bounds =
        animWorldBounds ||
        computeCompositeAnimationWorldBounds(
          skeleton,
          effectiveAnim,
          regionCanvasMap,
          allCompositeLayers,
          24
        );
      const { width: cellW, height: cellH } = computeNativeExportCellSize(bounds, 2048);
      const offCanvas = document.createElement('canvas');
      offCanvas.width = cellW;
      offCanvas.height = cellH;
      const ctx = offCanvas.getContext('2d');
      const animFrames: SlicedFrame[] = [];

      if (ctx) {
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0 : (i / count) * duration;
          renderSpineFrameToCanvas(
            ctx,
            cellW,
            cellH,
            skeleton,
            effectiveAnim,
            t,
            regionCanvasMap,
            1,
            0,
            0,
            bounds,
            allCompositeLayers
          );
          animFrames.push({
            id: `${selectedAnim}_${i}`,
            name: `${selectedAnim}_${String(i).padStart(3, '0')}`,
            width: cellW,
            height: cellH,
            sourceX: 0,
            sourceY: 0,
            sourceWidth: cellW,
            sourceHeight: cellH,
            rotate: 0,
            dataUrl: offCanvas.toDataURL('image/png'),
          });
        }
      }

      const extraFiles: Array<{ path: string; data: Uint8Array | string }> = [];

      // Fetch any MP4 cutscenes triggered by this animation
      for (const vRef of activeVideoRefs) {
        const rawUrl = resolveMediaVideoUrl(vRef, mediaProfile, ninja.atlasUrl);
        if (!rawUrl) continue;
        try {
          const resp = await fetch(resolveAssetFetchUrl(rawUrl));
          if (resp.ok) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            if (buf.byteLength > 0) {
              extraFiles.push({
                path: `videos/${sanitizePathSegment(vRef.resolvedName)}.mp4`,
                data: buf,
              });
            }
          }
        } catch {
          // ignore unavailable video
        }
      }

      // Fetch any MP3 audio cues triggered by this animation
      const uniqueSoundKeys = new Set<string>();
      for (const sRef of activeAudioRefs) {
        const clean = sRef.soundName.replace(/\.mp3$/i, '');
        if (!clean || uniqueSoundKeys.has(clean)) continue;
        uniqueSoundKeys.add(clean);
        const rawUrl = resolveMediaSoundUrl(clean, mediaProfile, ninja.atlasUrl);
        if (!rawUrl) continue;
        try {
          const resp = await fetch(resolveAssetFetchUrl(rawUrl));
          if (resp.ok) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            if (buf.byteLength > 0) {
              extraFiles.push({
                path: `audios/${sanitizePathSegment(clean)}.mp3`,
                data: buf,
              });
            }
          }
        } catch {
          // ignore unavailable sound
        }
      }

      // Fetch active skill icon for this animation if present
      const animSkillMeta = getAnimDisplayMeta(selectedAnim);
      if (animSkillMeta.iconUrl) {
        try {
          const iconFetchUrl = resolveAssetFetchUrl(animSkillMeta.iconUrl);
          if (iconFetchUrl) {
            const resp = await fetch(iconFetchUrl);
            if (resp.ok) {
              const buf = new Uint8Array(await resp.arrayBuffer());
              if (buf.byteLength > 0) {
                const isPng =
                  buf.length >= 4 &&
                  buf[0] === 0x89 &&
                  buf[1] === 0x50 &&
                  buf[2] === 0x4e &&
                  buf[3] === 0x47;
                const ext = isPng ? 'png' : 'webp';
                extraFiles.push({
                  path: `icone_skill_${sanitizePathSegment(selectedAnim)}.${ext}`,
                  data: buf,
                });
              }
            }
          }
        } catch {
          // ignore unavailable icon
        }
      }

      const suffix = allCompositeLayers.length > 0 ? '_com_poderes' : '';
      const rawRefsForAnim = extractSpineEffectRefs(skeleton, selectedAnim);
      const animInstructions = JSON.stringify(
        {
          characterId: ninja.id,
          displayName: mediaProfile?.displayName || ninja.name,
          animation: selectedAnim,
          effectiveAnimation: effectiveAnim !== selectedAnim ? effectiveAnim : undefined,
          durationSec: Number(duration.toFixed(4)),
          fps,
          frameCount: animFrames.length,
          effectMode,
          passiveAuraActive: showPassiveAura ? mediaProfile?.passiveAura?.id : undefined,
          effects: rawRefsForAnim.map((r) => ({
            spineId: r.spineId,
            effectAnim: r.animName,
            startTimeSec: Number(r.startTime.toFixed(4)),
            layer: r.layer,
            isSelfOrScreen: r.isSelfOrScreen,
            loop: r.loop,
            rawCommand: r.rawCommand,
          })),
          videos: activeVideoRefs.map((v) => ({
            key: v.resolvedName,
            startTimeSec: Number(v.time.toFixed(4)),
            file: `videos/${sanitizePathSegment(v.resolvedName)}.mp4`,
          })),
          sounds: activeAudioRefs.map((s) => ({
            soundName: s.soundName,
            timeSec: Number(s.time.toFixed(4)),
            file: `audios/${sanitizePathSegment(s.soundName.replace(/\.mp3$/i, ''))}.mp3`,
          })),
        },
        null,
        2
      );
      extraFiles.unshift({ path: 'instrucoes_animacao.json', data: animInstructions });

      await exportFramesAsZip(`${ninja.id}_${selectedAnim}${suffix}.zip`, animFrames, {
        extraFiles,
      });
    } finally {
      setExportingAnim(false);
    }
  };

  const handleRunCompleteCharacterExport = async () => {
    if (!ninja) return;
    const controller = new AbortController();
    completeExportAbortRef.current = controller;
    setCompleteExportError(null);
    setCompleteExportProgress({
      phase: 'base',
      message: 'Iniciando empacotamento completo...',
      percent: 2,
    });

    try {
      await exportCompleteCharacterZip(
        {
          ninja,
          atlasText,
          skeleton,
          pageUrls,
          pageImages,
          regionCanvasMap,
        },
        {
          effectScope: completeEffectScope,
          includeOriginalAndFrames: completeIncludeOriginals,
          includeLinkedEffects: completeIncludeEffects,
          includeAnimPngsAndSheets: completeIncludeAnimPngs,
          includeAnimGifs: completeIncludeAnimGifs,
          includePassiveAura: completeIncludePassiveAura,
          includeVideosAndAudio: completeIncludeVideosAndAudio,
          includeSkillIcons: completeIncludeSkillIcons,
          mediaProfile,
          gifBg: completeGifBg,
          fps: 24,
          signal: controller.signal,
          onProgress: (info) => setCompleteExportProgress(info),
        }
      );
      setShowCompleteExportModal(false);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setCompleteExportError(
          err instanceof Error ? err.message : 'Erro ao exportar personagem completo.'
        );
      }
    } finally {
      completeExportAbortRef.current = null;
      setCompleteExportProgress(null);
    }
  };

  const handleExportAnimGif = async () => {
    if (!skeleton || !effectiveAnim || !ninja) return;
    setGifProgress(0);
    const backgroundColor =
      gifBg === 'dark'
        ? '#090D14'
        : gifBg === 'light'
        ? '#F8FAFC'
        : gifBg === 'chroma'
        ? '#00B140'
        : null;
    try {
      const res = await exportAnimationGif(skeleton, effectiveAnim, regionCanvasMap, {
        fps: 24,
        bounds: animWorldBounds,
        backgroundColor,
        compositeLayers: allCompositeLayers,
        onProgress: (pct) => setGifProgress(pct),
      });
      const powerSuffix = allCompositeLayers.length > 0 ? '_poderes' : '';
      const bgSuffix = gifBg === 'transparent' ? '_sem_fundo' : `_${gifBg}`;
      downloadBlob(res.blob, `${ninja.id}_${selectedAnim}${powerSuffix}${bgSuffix}.gif`);
    } finally {
      setGifProgress(null);
    }
  };

  const handleDownloadRemoteMedia = async (rawUrl: string, filename: string) => {
    try {
      const fetchUrl = resolveAssetFetchUrl(rawUrl);
      if (fetchUrl) {
        const resp = await fetch(fetchUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          if (blob.size > 0) {
            downloadBlob(blob, filename);
            return;
          }
        }
      }
    } catch {
      // fall through to direct link download
    }

    // Direct anchor download fallback (works in static GitHub Pages mode even if CORS relay blocks large MP4/MP3)
    try {
      const a = document.createElement('a');
      a.href = resolveMediaPlayUrl(rawUrl) || rawUrl;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // ignore fallback failure
    }
  };

  const handleDownloadAllSkillIconsZip = async () => {
    if (!ninja || !mediaProfile || downloadingSkillIconsZip) return;
    setDownloadingSkillIconsZip(true);
    try {
      const iconFiles = await collectCharacterSkillIconFiles(mediaProfile);
      if (iconFiles.length === 0) return;
      const entries: StreamingZipEntry[] = [];
      for (const f of iconFiles) {
        const bytes =
          f.data instanceof Uint8Array
            ? f.data
            : f.data instanceof ArrayBuffer
            ? new Uint8Array(f.data)
            : f.data instanceof Blob
            ? new Uint8Array(await f.data.arrayBuffer())
            : new TextEncoder().encode(f.data);
        entries.push({
          path: f.path,
          blob: new Blob([bytes as Uint8Array<ArrayBuffer>]),
          size: bytes.byteLength,
          crc32: computeCrc32(bytes),
        });
      }
      const zipBlob = await assembleStreamingZipBlob(async function* () {
        yield entries;
      }, entries.length);
      downloadBlob(zipBlob, `${ninja.id}_icones_skills.zip`);
    } finally {
      setDownloadingSkillIconsZip(false);
    }
  };

  const handleDownloadBaseFramesZip = async () => {
    if (!ninja || downloadingBaseFramesZip) return;
    setDownloadingBaseFramesZip(true);
    try {
      const extraFiles: Array<{ path: string; data: Uint8Array | string }> = [];
      if (skeleton) {
        extraFiles.push({
          path: 'animacoes_instrucoes.json',
          data: buildCharacterInstructionsJson(
            ninja.id,
            skeleton,
            'all',
            undefined,
            undefined,
            mediaProfile
          ),
        });
      }
      if (mediaProfile) {
        const iconFiles = await collectCharacterSkillIconFiles(mediaProfile);
        for (const ic of iconFiles) {
          const bytes =
            ic.data instanceof Uint8Array
              ? ic.data
              : ic.data instanceof ArrayBuffer
              ? new Uint8Array(ic.data)
              : ic.data instanceof Blob
              ? new Uint8Array(await ic.data.arrayBuffer())
              : new TextEncoder().encode(ic.data);
          extraFiles.push({ path: ic.path, data: bytes });
        }
      }
      await exportFramesAsZip(`${ninja.id}_todos_frames.zip`, frames, {
        atlasText,
        atlasName: `${ninja.id}.atlas`,
        skeletonJson: skeleton,
        skeletonName: `${ninja.id}.json`,
        extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
      });
    } finally {
      setDownloadingBaseFramesZip(false);
    }
  };

  const handleToggleVoicePreview = (key: string, rawUrl: string) => {
    audioCuePlayer.unlock();
    if (playingVoiceKey === key) {
      audioCuePlayer.stopAll();
      setPlayingVoiceKey(null);
      return;
    }
    audioCuePlayer.stopAll();
    const playUrl = resolveMediaPlayUrl(rawUrl);
    if (!playUrl) {
      setPlayingVoiceKey(null);
      return;
    }
    setPlayingVoiceKey(key);
    const audio = audioCuePlayer.playOneShot(playUrl, soundVolume, false, () => {
      setPlayingVoiceKey((prev) => (prev === key ? null : prev));
    });
    if (!audio) {
      setPlayingVoiceKey(null);
    }
  };

  if (!ninja) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-slate-800 bg-[#131A26] p-10 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum ninja selecionado no Estúdio
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Escolha qualquer personagem no catálogo de Ninjas para reproduzir animações, inspecionar a folha de sprites e exportar frames individuais em PNG ou ZIP.
        </p>
        <button
          type="button"
          onClick={onBackToCatalog}
          className="mt-6 inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 transition-colors cursor-pointer"
        >
          Abrir Catálogo de Ninjas
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Studio Sub-header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToCatalog}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white cursor-pointer"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Catálogo</span>
          </button>
          <div>
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-lg font-semibold text-slate-50">
                {mediaProfile?.displayName || ninja.name || ninja.id}
              </h2>
              {(mediaProfile?.displayName || ninja.name) && (
                <span className="font-mono text-xs text-slate-400">{ninja.id}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              {ninja.width} × {ninja.height} px · {frames.length} frames · {animNames.length} animações
              {mediaProfile?.passiveAura ? ` · Aura: ${mediaProfile.passiveAura.label}` : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mode Switcher */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#131A26] p-1">
            <button
              type="button"
              onClick={() => setStageMode('player')}
              disabled={animNames.length === 0}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 ${
                stageMode === 'player'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <Film className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Animações</span>
            </button>
            <button
              type="button"
              onClick={() => setStageMode('frames')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                stageMode === 'frames'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <Grid className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Frames Fatiados ({frames.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setStageMode('sheet')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                stageMode === 'sheet'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Folha Original</span>
            </button>
          </div>

          <button
            type="button"
            disabled={loading || Boolean(error)}
            onClick={() => setShowCompleteExportModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Baixar Completo (ZIP)</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex h-80 items-center justify-center rounded-lg border border-slate-800 bg-[#131A26]">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-orange-500" />
            <p className="mt-3 text-sm text-slate-300">
              Baixando atlas, skeleton e folha WebP de {ninja.id}...
            </p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && frames.length > 0 && !skeleton && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/25 px-4 py-3 text-xs text-amber-200">
          Modo estático: os frames fatiados e a folha original foram carregados normalmente para visualização e exportação em PNG/ZIP. Para reproduzir animações Spine (.json) no GitHub Pages, configure um Proxy CORS próprio (ex: Cloudflare Worker) nas opções da aba Extrator URL.
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          {/* Main Stage */}
          <div className="min-w-0 space-y-4">
            {stageMode === 'player' && (
              <div
                style={
                  playerDetached && dockHeight > 0
                    ? { minHeight: `${dockHeight}px` }
                    : undefined
                }
              >
                {playerDetached && (
                  <div className="flex items-center justify-between rounded-lg border border-dashed border-slate-700/80 bg-[#131A26]/50 px-4 py-6 text-xs text-slate-400">
                    <span>Player exibido em tela cheia · Animação: {selectedAnim}</span>
                    <button
                      type="button"
                      onClick={closeDetachedPlayer}
                      className="rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      Recolher aqui
                    </button>
                  </div>
                )}

                <div
                  className={
                    playerDetached
                      ? 'fixed inset-0 z-50 overflow-y-auto bg-[#0B0F17]/96 p-3 sm:p-6'
                      : ''
                  }
                  onClick={
                    playerDetached
                      ? (e) => {
                          if (e.target === e.currentTarget) {
                            closeDetachedPlayer();
                          }
                        }
                      : undefined
                  }
                  role={playerDetached ? 'dialog' : undefined}
                  aria-modal={playerDetached ? true : undefined}
                  aria-label={playerDetached ? `Player de animação ${ninja.id}` : undefined}
                >
                  <div
                    ref={!playerDetached ? playerBoxRef : undefined}
                    className={`rounded-lg border border-slate-800 bg-[#131A26] ${
                      playerDetached
                        ? 'mx-auto my-2 w-full max-w-6xl border-slate-700/80 shadow-2xl'
                        : 'overflow-hidden'
                    }`}
                  >
                    {playerDetached && (
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-lg border-b border-slate-800/80 bg-[#0F1520] px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5 text-xs">
                          {selectedAnimMeta.iconUrl && (
                            <img
                              src={resolveAssetFetchUrl(selectedAnimMeta.iconUrl)}
                              alt={selectedAnimMeta.shortLabel || selectedAnim}
                              className="h-7 w-7 shrink-0 rounded border border-slate-700 bg-[#0B0F17] object-contain"
                            />
                          )}
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate font-mono font-semibold text-slate-100">
                              {ninja.id}
                            </span>
                            <span className="text-slate-500" aria-hidden="true">
                              ·
                            </span>
                            <span className="truncate font-mono font-medium text-orange-400">
                              {selectedAnim}
                            </span>
                            {selectedAnimMeta.shortLabel && (
                              <span className="truncate text-slate-300">
                                ({selectedAnimMeta.shortLabel})
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={closeDetachedPlayer}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-4 py-2 text-xs font-semibold text-slate-100 hover:border-orange-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                          <span>Fechar</span>
                        </button>
                      </div>
                    )}

                    {/* Canvas Toolbar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5">
                          {(
                            [
                              { id: 'checker', label: 'Xadrez' },
                              { id: 'dark', label: 'Escuro' },
                              { id: 'light', label: 'Claro' },
                              { id: 'chroma', label: 'Chroma' },
                            ] as const
                          ).map((bg) => (
                            <button
                              key={bg.id}
                              type="button"
                              onClick={() => setBgStyle(bg.id)}
                              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                bgStyle === bg.id
                                  ? 'bg-slate-700 text-white'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {bg.label}
                            </button>
                          ))}
                        </div>

                        {rawEffectRefs.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 rounded border border-slate-800 bg-[#0B0F17] p-0.5">
                            {hasSelfPowers && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('powers')}
                                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'powers'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                Com poderes
                              </button>
                            )}
                            {hasImpactEffects && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('all')}
                                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'all'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                {hasSelfPowers ? 'Completa (+ impactos)' : 'Com efeitos'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setEffectMode('base')}
                              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                effectMode === 'base'
                                  ? 'bg-slate-700 text-white'
                                  : 'text-slate-400 hover:text-slate-100'
                              }`}
                            >
                              Somente ninja
                            </button>
                          </div>
                        )}

                        {mediaProfile?.passiveAura && (
                          <div className="flex items-center gap-1 rounded border border-purple-500/40 bg-purple-950/30 p-0.5">
                            <button
                              type="button"
                              onClick={() => setShowPassiveAura((v) => !v)}
                              title={`Alternar aura passiva (${mediaProfile.passiveAura.label})`}
                              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                showPassiveAura
                                  ? 'bg-purple-600 text-white'
                                  : 'text-purple-200 hover:bg-purple-900/50'
                              }`}
                            >
                              <Sparkles className="h-3 w-3" aria-hidden="true" />
                              <span>Aura Passiva</span>
                            </button>
                            {showPassiveAura &&
                              mediaProfile.passiveAura.layers.some(
                                (l) => l.introAnim || l.outroAnim
                              ) && (
                                <select
                                  value={passiveAuraPhase}
                                  onChange={(e) =>
                                    setPassiveAuraPhase(
                                      e.target.value as 'loop' | 'intro' | 'outro'
                                    )
                                  }
                                  aria-label="Fase da aura passiva"
                                  className="rounded bg-[#0B0F17] px-1.5 py-1 text-[11px] text-purple-100 focus:outline-none cursor-pointer"
                                >
                                  <option value="loop">Contínua</option>
                                  <option value="intro">Entrada</option>
                                  <option value="outro">Saída</option>
                                </select>
                              )}
                          </div>
                        )}

                        {activeVideoRefs.length > 0 && (
                          <div className="flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/25 p-0.5">
                            <button
                              type="button"
                              onClick={() => setEnableVideoCutscene((v) => !v)}
                              title="Reproduzir vídeo MP4 da ultimate automaticamente durante a animação"
                              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                enableVideoCutscene
                                  ? 'bg-cyan-600 text-white'
                                  : 'text-cyan-200 hover:bg-cyan-900/50'
                              }`}
                            >
                              <Clapperboard className="h-3 w-3" aria-hidden="true" />
                              <span>Vídeo MP4</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                audioCuePlayer.unlock();
                                const first = activeVideoRefs[0];
                                const rawUrl =
                                  first &&
                                  resolveMediaVideoUrl(first, mediaProfile, ninja.atlasUrl);
                                if (!rawUrl || !first) return;
                                const playUrl = resolveMediaPlayUrl(rawUrl);
                                if (!playUrl) return;
                                setActiveVideoOverlay({
                                  playUrl,
                                  rawUrl,
                                  label: `Ultimate MP4 · ${first.resolvedName}`,
                                  key: first.resolvedName,
                                  resumePlaying: isPlaying,
                                });
                              }}
                              className="rounded px-2 py-1 text-[11px] font-medium text-cyan-100 hover:bg-cyan-900/50 whitespace-nowrap cursor-pointer"
                            >
                              Assistir
                            </button>
                          </div>
                        )}

                        <div className="flex items-center gap-1.5 rounded border border-slate-800 bg-[#0B0F17] px-2 py-1">
                          <button
                            type="button"
                            onClick={() => {
                              audioCuePlayer.unlock();
                              setSoundMuted((m) => !m);
                            }}
                            aria-label={soundMuted ? 'Ativar som' : 'Silenciar som'}
                            title={soundMuted ? 'Ativar som' : 'Silenciar som'}
                            className={`inline-flex items-center gap-1 text-xs font-medium cursor-pointer ${
                              soundMuted
                                ? 'text-slate-500 hover:text-slate-300'
                                : 'text-emerald-300 hover:text-emerald-200'
                            }`}
                          >
                            {soundMuted ? (
                              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <span>{soundMuted ? 'Mudo' : 'Som'}</span>
                          </button>
                          {!soundMuted && (
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={soundVolume}
                              onChange={(e) => setSoundVolume(Number(e.target.value))}
                              aria-label="Volume do áudio"
                              className="w-14 accent-emerald-500 cursor-pointer"
                            />
                          )}
                        </div>

                        {(loadingEffects || loadingPassiveAura) && (
                          <span className="text-xs text-orange-300 font-mono whitespace-nowrap">
                            {loadingPassiveAura ? 'Carregando aura...' : 'Carregando poderes...'}
                          </span>
                        )}
                        {!loadingEffects && effectLoadError && (
                          <span className="text-xs text-amber-300 font-mono whitespace-nowrap">
                            {effectLoadError}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1 rounded border border-slate-800 bg-[#0B0F17] p-0.5">
                          <button
                            type="button"
                            onClick={() =>
                              setPan((p) => clampPlayerPan(p.x - 24, p.y, zoom))
                            }
                            aria-label="Mover para esquerda"
                            title="Mover esquerda"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPan((p) => clampPlayerPan(p.x, p.y - 24, zoom))
                            }
                            aria-label="Mover para cima"
                            title="Mover cima"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPan((p) => clampPlayerPan(p.x, p.y + 24, zoom))
                            }
                            aria-label="Mover para baixo"
                            title="Mover baixo"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPan((p) => clampPlayerPan(p.x + 24, p.y, zoom))
                            }
                            aria-label="Mover para direita"
                            title="Mover direita"
                            className="rounded p-1 text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setAutoFit(true);
                            setPan({ x: 0, y: 0 });
                          }}
                          title="Centralizar animação mantendo o zoom atual"
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                            pan.x !== 0 || pan.y !== 0
                              ? 'border-orange-500/60 bg-orange-950/30 text-orange-200 hover:border-orange-400'
                              : 'border-slate-800 bg-[#0B0F17] text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <Crosshair className="h-3 w-3" aria-hidden="true" />
                          <span>Centralizar</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setAutoFit(true);
                            setZoom(1);
                            setPan({ x: 0, y: 0 });
                          }}
                          title="Resetar zoom para 100% e enquadrar animação inteira"
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                            autoFit && zoom === 1 && pan.x === 0 && pan.y === 0
                              ? 'border-orange-500/60 bg-orange-950/30 text-orange-200'
                              : 'border-slate-800 bg-[#0B0F17] text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <Maximize2 className="h-3 w-3" aria-hidden="true" />
                          <span>Enquadrar 100%</span>
                        </button>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => applyZoom((z) => z - 0.15)}
                            aria-label="Diminuir zoom"
                            className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                          >
                            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <span className="w-11 text-center font-mono text-xs text-slate-300 tabular-nums">
                            {Math.round(zoom * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() => applyZoom((z) => z + 0.15)}
                            aria-label="Aumentar zoom"
                            className="rounded border border-slate-800 bg-[#0B0F17] p-1.5 text-slate-300 hover:border-slate-600 cursor-pointer"
                          >
                            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Stage Canvas (supports touch/mouse drag to pan) */}
                    <div
                      className={`${bgClass} relative flex items-center justify-center p-4 ${
                        playerDetached ? 'min-h-[260px]' : ''
                      }`}
                    >
                      <canvas
                        key={playerDetached ? 'player-detached' : 'player-docked'}
                        ref={playerCanvasRef}
                        width={640}
                        height={420}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture(e.pointerId);
                          dragStartRef.current = {
                            x: e.clientX,
                            y: e.clientY,
                            panX: pan.x,
                            panY: pan.y,
                          };
                        }}
                        onPointerMove={(e) => {
                          const d = dragStartRef.current;
                          if (!d) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const scaleX = e.currentTarget.width / Math.max(1, rect.width);
                          const scaleY = e.currentTarget.height / Math.max(1, rect.height);
                          setPan(
                            clampPlayerPan(
                              d.panX + (e.clientX - d.x) * scaleX,
                              d.panY + (e.clientY - d.y) * scaleY,
                              zoom
                            )
                          );
                        }}
                        onPointerUp={(e) => {
                          dragStartRef.current = null;
                          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                          }
                        }}
                        onPointerCancel={() => {
                          dragStartRef.current = null;
                        }}
                        className="max-h-[420px] w-full max-w-[640px] object-contain touch-none cursor-grab active:cursor-grabbing"
                      />
                      <span className="pointer-events-none absolute bottom-2 right-3 rounded bg-black/55 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                        {zoom > 1.02
                          ? 'Arraste para mover · Câmera acompanhando a animação'
                          : 'Arraste para mover · Enquadramento automático ativo'}
                      </span>

                      {activeVideoOverlay && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/92 p-3">
                          <div className="relative flex h-full w-full max-w-[640px] flex-col items-center justify-center">
                            <video
                              key={activeVideoOverlay.playUrl}
                              ref={videoElemRef}
                              src={activeVideoOverlay.playUrl}
                              autoPlay
                              playsInline
                              preload="auto"
                              controls
                              muted={soundMuted || videoAutoplayMuted}
                              onLoadedMetadata={(e) => {
                                e.currentTarget.volume = soundVolume;
                                if (e.currentTarget.paused && !e.currentTarget.ended) {
                                  startVideoAutoplay(e.currentTarget);
                                }
                              }}
                              onCanPlay={(e) => {
                                if (e.currentTarget.paused && !e.currentTarget.ended) {
                                  startVideoAutoplay(e.currentTarget);
                                }
                              }}
                              onEnded={() => {
                                const resume = activeVideoOverlay.resumePlaying;
                                setActiveVideoOverlay(null);
                                if (resume) setIsPlaying(true);
                              }}
                              onError={() => {
                                setActiveVideoOverlay(null);
                              }}
                              className="max-h-[360px] w-full rounded-md border border-slate-700 bg-black object-contain"
                            />
                            <div className="mt-2 flex w-full flex-wrap items-center justify-between gap-2 text-xs">
                              <span className="truncate font-mono text-cyan-200">
                                {activeVideoOverlay.label}
                              </span>
                              <div className="flex items-center gap-2">
                                {videoAutoplayMuted && !soundMuted && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      audioCuePlayer.unlock();
                                      setVideoAutoplayMuted(false);
                                      if (videoElemRef.current) {
                                        videoElemRef.current.muted = false;
                                        videoElemRef.current.volume = soundVolume;
                                        void videoElemRef.current.play().catch(() => {});
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-950/60 px-2.5 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/70 cursor-pointer"
                                  >
                                    <Volume2 className="h-3 w-3" aria-hidden="true" />
                                    <span>Ativar som</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDownloadRemoteMedia(
                                      activeVideoOverlay.rawUrl,
                                      `${ninja.id}_${sanitizePathSegment(activeVideoOverlay.key)}.mp4`
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/40 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-900/50 cursor-pointer"
                                >
                                  <Download className="h-3 w-3" aria-hidden="true" />
                                  <span>Baixar MP4</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const resume = activeVideoOverlay.resumePlaying;
                                    setActiveVideoOverlay(null);
                                    if (resume) setIsPlaying(true);
                                  }}
                                  className="rounded bg-orange-600 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                                >
                                  Pular vídeo
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                {/* Playback & Export Controls */}
                <div className="space-y-3 border-t border-slate-800/80 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime((t) => Math.max(0, t - 1 / 30));
                      }}
                      aria-label="Frame anterior"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] p-2 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <SkipBack className="h-4 w-4" aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        audioCuePlayer.unlock();
                        setIsPlaying((p) => !p);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                    >
                      {isPlaying ? (
                        <>
                          <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Pausar</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Reproduzir</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime((t) => (duration > 0 ? (t + 1 / 30) % duration : 0));
                      }}
                      aria-label="Próximo frame"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] p-2 text-slate-300 hover:border-slate-600 cursor-pointer"
                    >
                      <SkipForward className="h-4 w-4" aria-hidden="true" />
                    </button>

                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.01, duration)}
                      step={0.01}
                      value={Math.min(currentTime, duration)}
                      onChange={(e) => {
                        setIsPlaying(false);
                        setCurrentTime(Number(e.target.value));
                      }}
                      aria-label="Linha do tempo da animação"
                      className="min-w-[140px] flex-1 accent-orange-500 cursor-pointer"
                    />

                    <span className="font-mono text-xs text-slate-300 tabular-nums">
                      {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                    </span>

                    <select
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      aria-label="Velocidade da animação"
                      className="rounded-lg border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-xs text-slate-200 cursor-pointer"
                    >
                      <option value={0.25}>0.25x</option>
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleDownloadCurrentCanvasFrame}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Baixar Frame Atual PNG</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportAnimStrip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Exportar Spritesheet ({selectedAnim})</span>
                    </button>
                    <div className="inline-flex items-center overflow-hidden rounded-lg border border-emerald-500/40 bg-emerald-950/30">
                      <select
                        value={gifBg}
                        disabled={exportingAnim || gifProgress !== null}
                        onChange={(e) =>
                          setGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        aria-label="Fundo do GIF"
                        className="border-r border-emerald-500/30 bg-transparent px-2 py-1.5 text-xs text-emerald-100 focus:outline-none cursor-pointer disabled:opacity-50"
                      >
                        <option value="transparent" className="bg-[#0B0F17] text-slate-100">
                          Sem fundo
                        </option>
                        <option value="dark" className="bg-[#0B0F17] text-slate-100">
                          Fundo escuro
                        </option>
                        <option value="light" className="bg-[#0B0F17] text-slate-100">
                          Fundo claro
                        </option>
                        <option value="chroma" className="bg-[#0B0F17] text-slate-100">
                          Chroma verde
                        </option>
                      </select>
                      <button
                        type="button"
                        disabled={exportingAnim || gifProgress !== null}
                        onClick={() => void handleExportAnimGif()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50 cursor-pointer"
                      >
                        <Film className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {gifProgress !== null
                            ? `Gerando GIF (${gifProgress}%)...`
                            : `Exportar GIF (${selectedAnim})`}
                        </span>
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={exportingAnim || gifProgress !== null}
                      onClick={handleExportAnimZip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-950/30 px-3 py-1.5 text-xs font-medium text-orange-200 hover:bg-orange-900/40 disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {exportingAnim
                          ? 'Renderizando...'
                          : `Baixar Frames "${selectedAnim}" (ZIP)`}
                      </span>
                    </button>
                  </div>
                </div>
                  </div>
                </div>
              </div>
            )}

            {stageMode === 'frames' && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <input
                    type="search"
                    value={frameFilter}
                    onChange={(e) => setFrameFilter(e.target.value)}
                    placeholder="Filtrar frame (ex: a33, a0)..."
                    className="w-60 rounded-lg border border-slate-800 bg-[#0B0F17] px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCompleteExportModal(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Personagem Completo + Animações (ZIP)</span>
                    </button>
                    <button
                      type="button"
                      disabled={downloadingBaseFramesZip}
                      onClick={() => void handleDownloadBaseFramesZip()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {downloadingBaseFramesZip
                          ? 'Compactando...'
                          : `Baixar Frames Base + Ícones (${frames.length})`}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {filteredFrames.map((frame) => (
                    <div
                      key={frame.id}
                      className="flex flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#0B0F17]"
                    >
                      <div className="sprite-checkerboard flex h-28 items-center justify-center p-2">
                        <img
                          src={frame.dataUrl}
                          alt={frame.name}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs font-medium text-slate-100">
                            {frame.name}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {frame.width}×{frame.height}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            downloadDataUrl(frame.dataUrl, `${ninja.id}_${frame.name}.png`)
                          }
                          aria-label={`Baixar ${frame.name}`}
                          className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white cursor-pointer"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stageMode === 'sheet' && (
              <div className="space-y-4">
                {pages.map((page) => {
                  const img = pageImages[page.name];
                  const proxyUrl = pageUrls[page.name];
                  return (
                    <div
                      key={page.name}
                      className="overflow-hidden rounded-lg border border-slate-800 bg-[#131A26]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
                        <div className="font-mono text-xs text-slate-300 tabular-nums">
                          {page.name} · {img?.width || page.width} × {img?.height || page.height} px ·{' '}
                          {page.regions.length} regiões
                        </div>
                        <div className="flex items-center gap-3">
                          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={showAtlasBoxes}
                              onChange={(e) => setShowAtlasBoxes(e.target.checked)}
                              className="accent-orange-500"
                            />
                            <span>Mostrar caixas do Atlas</span>
                          </label>
                          {proxyUrl && (
                            <a
                              href={proxyUrl}
                              download={page.name}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Baixar Folha</span>
                            </a>
                          )}
                        </div>
                      </div>

                      {selectedRegion && selectedRegion.pageName === page.name && (
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0B0F17] px-4 py-2 text-xs font-mono text-slate-300 tabular-nums">
                          <span>
                            Região: <strong className="text-orange-400">{selectedRegion.name}</strong> · xy ({selectedRegion.x}, {selectedRegion.y}) · size {selectedRegion.width}×{selectedRegion.height} · rot {selectedRegion.rotate}°
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const frame = frames.find((f) => f.name === selectedRegion.name);
                              if (frame) downloadDataUrl(frame.dataUrl, `${ninja.id}_${frame.name}.png`);
                            }}
                            className="text-orange-400 hover:underline cursor-pointer"
                          >
                            Baixar região PNG
                          </button>
                        </div>
                      )}

                      <div className="sprite-checkerboard max-h-[600px] overflow-auto p-4">
                        {img && (
                          <div
                            className="relative inline-block"
                            style={{ width: img.width, height: img.height }}
                          >
                            <img
                              src={proxyUrl}
                              alt={page.name}
                              referrerPolicy="no-referrer"
                              className="block"
                            />
                            {showAtlasBoxes &&
                              page.regions.map((reg, idx) => {
                                const w = reg.rotate === 90 ? reg.height : reg.width;
                                const h = reg.rotate === 90 ? reg.width : reg.height;
                                const isSel = selectedRegion === reg;
                                return (
                                  <button
                                    key={`${reg.name}-${idx}`}
                                    type="button"
                                    title={`${reg.name} (${reg.width}×${reg.height})`}
                                    onClick={() => setSelectedRegion(reg)}
                                    style={{
                                      left: reg.x,
                                      top: reg.y,
                                      width: w,
                                      height: h,
                                    }}
                                    className={`absolute border transition-colors cursor-pointer ${
                                      isSel
                                        ? 'border-orange-400 bg-orange-500/25'
                                        : 'border-cyan-400/45 hover:border-orange-400 hover:bg-orange-500/15'
                                    }`}
                                  />
                                );
                              })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Inspector Sidebar */}
          <aside className="space-y-4">
            <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Especificações do Ativo
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Identificador</dt>
                  <dd className="font-mono text-slate-100">{ninja.id}</dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Dimensão Base</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">
                    {ninja.width} × {ninja.height} px
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Frames Fatiados</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">{frames.length}</dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
                  <dt className="text-slate-400">Versão Spine</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">
                    {skeleton?.skeleton?.spine || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Folhas (Pages)</dt>
                  <dd className="font-mono text-slate-100 tabular-nums">{pages.length}</dd>
                </div>
              </dl>
            </div>

            {animNames.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    Animações ({animNames.length})
                  </h3>
                </div>
                <input
                  type="search"
                  value={animFilter}
                  onChange={(e) => setAnimFilter(e.target.value)}
                  placeholder="Buscar animação..."
                  aria-label="Filtrar animações"
                  className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 text-base sm:text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
                <div className="max-h-[360px] space-y-1 overflow-y-auto pr-1">
                  {filteredAnimNames.map((anim) => {
                    const active = anim === selectedAnim && stageMode === 'player';
                    const eff = skeleton ? resolveEffectiveAnimationName(skeleton, anim) : anim;
                    const dur = skeleton ? getAnimationDuration(skeleton, eff) : 0;
                    const effRefs = animEffectMap.get(anim) || [];
                    const audioRefs = animAudioMap.get(anim) || [];
                    const videoRefs = animVideoMap.get(anim) || [];
                    const hasPowers = effRefs.some((r) => r.isSelfOrScreen);
                    const hasImpacts = !hasPowers && effRefs.length > 0;
                    const hasAuraHere =
                      Boolean(mediaProfile?.passiveAura) && eff.toLowerCase() === 'idle';
                    const meta = getAnimDisplayMeta(anim);

                    return (
                      <button
                        key={anim}
                        type="button"
                        onClick={() => {
                          audioCuePlayer.unlock();
                          setSelectedAnim(anim);
                          setCurrentTime(0);
                          animTimeRef.current = 0;
                          prevAnimTimeRef.current = -1;
                          videoTriggeredCycleRef.current = false;
                          setActiveVideoOverlay(null);
                          setAutoFit(true);
                          setZoom(1);
                          setPan({ x: 0, y: 0 });
                          setStageMode('player');
                          setIsPlaying(true);
                          setEffectMode(hasPowers ? 'powers' : hasImpacts ? 'all' : 'base');
                          openDetachedPlayer();
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-orange-600 text-white font-medium'
                            : 'text-slate-300 hover:bg-slate-800/70'
                        }`}
                      >
                        {meta.iconUrl && (
                          <img
                            src={resolveAssetFetchUrl(meta.iconUrl)}
                            alt={meta.shortLabel || anim}
                            loading="lazy"
                            className={`h-8 w-8 shrink-0 rounded border object-contain ${
                              active
                                ? 'border-orange-200/70 bg-black/25'
                                : 'border-slate-700/80 bg-[#0B0F17]'
                            }`}
                          />
                        )}
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex w-full items-center justify-between gap-2">
                            <span className="truncate font-mono">{anim}</span>
                            <span
                              className={`shrink-0 font-mono text-[10px] tabular-nums ${
                                active ? 'text-orange-100' : 'text-slate-500'
                              }`}
                            >
                              {dur.toFixed(2)}s
                            </span>
                          </div>
                          {(meta.shortLabel ||
                            hasAuraHere ||
                            hasPowers ||
                            hasImpacts ||
                            videoRefs.length > 0 ||
                            audioRefs.length > 0) && (
                            <div className="flex flex-wrap items-center gap-1">
                              {meta.shortLabel && (
                                <span
                                  className={`truncate text-[10px] ${
                                    active ? 'text-orange-100' : 'text-slate-400'
                                  }`}
                                >
                                  {meta.label}
                                </span>
                              )}
                              {hasAuraHere && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[9px] font-semibold ${
                                    active
                                      ? 'bg-purple-900/60 text-purple-100'
                                      : 'bg-purple-950/70 text-purple-300'
                                  }`}
                                >
                                  Aura
                                </span>
                              )}
                              {(hasPowers || hasImpacts) && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[9px] font-semibold ${
                                    active
                                      ? 'bg-black/25 text-white'
                                      : 'bg-orange-950/70 text-orange-300'
                                  }`}
                                >
                                  {hasPowers ? 'Poder' : 'Efeito'}
                                </span>
                              )}
                              {videoRefs.length > 0 && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[9px] font-semibold ${
                                    active
                                      ? 'bg-cyan-900/60 text-cyan-100'
                                      : 'bg-cyan-950/70 text-cyan-300'
                                  }`}
                                >
                                  MP4
                                </span>
                              )}
                              {audioRefs.length > 0 && (
                                <span
                                  className={`rounded px-1 py-0.2 text-[9px] font-semibold ${
                                    active
                                      ? 'bg-emerald-900/60 text-emerald-100'
                                      : 'bg-emerald-950/70 text-emerald-300'
                                  }`}
                                >
                                  Som
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Skills & Passives Icons Card */}
            {orderedSkillList.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    Habilidades & Ícones ({orderedSkillList.length})
                  </h3>
                  {skillIconCount > 0 && (
                    <button
                      type="button"
                      disabled={downloadingSkillIconsZip}
                      onClick={() => void handleDownloadAllSkillIconsZip()}
                      title="Baixar todos os ícones das habilidades e passivas em ZIP (PNG qualidade máxima)"
                      className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-950/30 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <Download className="h-3 w-3" aria-hidden="true" />
                      <span>{downloadingSkillIconsZip ? 'Gerando...' : `ZIP (${skillIconCount})`}</span>
                    </button>
                  )}
                </div>

                <div className="max-h-[340px] space-y-1.5 overflow-y-auto pr-1">
                  {orderedSkillList.map((item) => {
                    const matchedAnim =
                      !item.isPassive && item.animKey
                        ? animNames.find((a) => a === item.animKey) ||
                          animNames.find((a) => a.toLowerCase() === item.animKey!.toLowerCase())
                        : undefined;
                    const iconSrc = item.iconUrl ? resolveAssetFetchUrl(item.iconUrl) : '';
                    const downloadName = `${ninja.id}_${sanitizePathSegment(item.slotLabel)}_${sanitizePathSegment(item.name)}.png`;

                    return (
                      <div
                        key={item.key}
                        title={item.desc || item.name}
                        className="flex items-center gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2 text-xs"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-700/80 bg-[#131A26]">
                          {iconSrc ? (
                            <img
                              src={iconSrc}
                              alt={item.name}
                              loading="lazy"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <Sparkles className="h-4 w-4 text-slate-600" aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                                item.isPassive
                                  ? 'bg-purple-950/70 text-purple-300'
                                  : 'bg-amber-950/70 text-amber-300'
                              }`}
                            >
                              {item.slotLabel}
                            </span>
                            {matchedAnim && (
                              <button
                                type="button"
                                onClick={() => {
                                  audioCuePlayer.unlock();
                                  const effRefs = animEffectMap.get(matchedAnim) || [];
                                  const hasP = effRefs.some((r) => r.isSelfOrScreen);
                                  const hasI = !hasP && effRefs.length > 0;
                                  setSelectedAnim(matchedAnim);
                                  setCurrentTime(0);
                                  animTimeRef.current = 0;
                                  prevAnimTimeRef.current = -1;
                                  videoTriggeredCycleRef.current = false;
                                  setActiveVideoOverlay(null);
                                  setAutoFit(true);
                                  setZoom(1);
                                  setPan({ x: 0, y: 0 });
                                  setStageMode('player');
                                  setIsPlaying(true);
                                  setEffectMode(hasP ? 'powers' : hasI ? 'all' : 'base');
                                  openDetachedPlayer();
                                }}
                                className="truncate font-mono text-[10px] text-orange-400 hover:underline cursor-pointer"
                              >
                                ver {matchedAnim}
                              </button>
                            )}
                          </div>
                          <div className="mt-0.5 truncate font-medium text-slate-100">
                            {item.name}
                          </div>
                          {item.desc && (
                            <div className="line-clamp-2 text-[10px] leading-snug text-slate-400">
                              {item.desc}
                            </div>
                          )}
                        </div>
                        {item.iconUrl && (
                          <button
                            type="button"
                            onClick={() => void handleDownloadRemoteMedia(item.iconUrl!, downloadName)}
                            title="Baixar ícone em PNG (qualidade máxima)"
                            className="shrink-0 rounded border border-slate-700 bg-[#131A26] p-1.5 text-slate-300 hover:border-amber-500/60 hover:text-amber-200 cursor-pointer"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Passive Aura, Ultimate Videos & Voices Card */}
            {(mediaProfile?.passiveAura ||
              (mediaProfile?.videos && mediaProfile.videos.length > 0) ||
              (mediaProfile?.voices && mediaProfile.voices.length > 0)) && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-4 space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Mídia, Aura & Vozes
                </h3>

                {mediaProfile.passiveAura && (
                  <div className="rounded-md border border-purple-500/30 bg-purple-950/20 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-200">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{mediaProfile.passiveAura.label}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowPassiveAura((v) => !v)}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
                          showPassiveAura
                            ? 'bg-purple-600 text-white'
                            : 'border border-purple-500/40 text-purple-200'
                        }`}
                      >
                        {showPassiveAura ? 'Ativa' : 'Ativar'}
                      </button>
                    </div>
                    <p className="font-mono text-[10px] text-slate-400">
                      {mediaProfile.passiveAura.id} · incluída no ZIP completo
                    </p>
                  </div>
                )}

                {mediaProfile.videos.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-slate-400">
                      Vídeos da Ultimate ({mediaProfile.videos.length})
                    </div>
                    {mediaProfile.videos.map((vid) => (
                      <div
                        key={vid.key}
                        className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-cyan-200">{vid.label}</div>
                          <div className="truncate font-mono text-[10px] text-slate-500">
                            {vid.key}.mp4
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              audioCuePlayer.unlock();
                              const playUrl = resolveMediaPlayUrl(vid.url);
                              if (!playUrl) return;
                              setStageMode('player');
                              setActiveVideoOverlay({
                                playUrl,
                                rawUrl: vid.url,
                                label: `${vid.label} · ${vid.key}`,
                                key: vid.key,
                                resumePlaying: isPlaying,
                              });
                              openDetachedPlayer();
                            }}
                            title="Assistir vídeo MP4"
                            className="rounded border border-cyan-500/40 bg-cyan-950/40 p-1.5 text-cyan-200 hover:bg-cyan-900/50 cursor-pointer"
                          >
                            <Play className="h-3 w-3" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleDownloadRemoteMedia(
                                vid.url,
                                `${ninja.id}_${sanitizePathSegment(vid.key)}.mp4`
                              )
                            }
                            title="Baixar MP4"
                            className="rounded border border-slate-700 bg-[#131A26] p-1.5 text-slate-300 hover:border-slate-500 hover:text-white cursor-pointer"
                          >
                            <Download className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {mediaProfile.voices.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Music className="h-3 w-3" aria-hidden="true" />
                        <span>Vozes do Personagem ({mediaProfile.voices.length})</span>
                      </span>
                    </div>
                    <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                      {mediaProfile.voices.map((voice) => {
                        const isPlayingThis = playingVoiceKey === voice.key;
                        return (
                          <div
                            key={`${voice.category}_${voice.key}`}
                            className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1.5 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-slate-200">{voice.label}</div>
                              <div className="truncate font-mono text-[10px] text-slate-500">
                                {voice.key}.mp3
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleToggleVoicePreview(voice.key, voice.url)}
                                title={isPlayingThis ? 'Parar voz' : 'Ouvir voz'}
                                className={`rounded p-1.5 cursor-pointer ${
                                  isPlayingThis
                                    ? 'bg-emerald-600 text-white'
                                    : 'border border-emerald-500/40 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-900/40'
                                }`}
                              >
                                {isPlayingThis ? (
                                  <Pause className="h-3 w-3" aria-hidden="true" />
                                ) : (
                                  <Volume2 className="h-3 w-3" aria-hidden="true" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDownloadRemoteMedia(
                                    voice.url,
                                    `${ninja.id}_${sanitizePathSegment(`${voice.category}_${voice.key}`)}.mp3`
                                  )
                                }
                                title="Baixar MP3"
                                className="rounded border border-slate-700 bg-[#131A26] p-1.5 text-slate-300 hover:border-slate-500 hover:text-white cursor-pointer"
                              >
                                <Download className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}

      {showCompleteExportModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="complete-char-export-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-[#131A26] p-5 space-y-4 max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <h3
                  id="complete-char-export-title"
                  className="font-display text-base font-semibold text-slate-50"
                >
                  Exportar Personagem Completo (ZIP)
                </h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400">
                  {ninja.id} · {frames.length} frames · {animNames.length} animações ·{' '}
                  {completeEffectPlan.uniqueSpineIds.length} pacote(s) de partículas
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(completeExportProgress)}
                onClick={() => setShowCompleteExportModal(false)}
                aria-label="Fechar janela"
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {completeEffectPlan.uniqueSpineIds.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 space-y-1.5">
                <div className="text-[11px] font-medium text-slate-300">
                  Pacotes de partículas vinculados encontrados no <code className="font-mono text-orange-300">.json</code>:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {completeEffectPlan.uniqueSpineIds.map((effId) => (
                    <span
                      key={effId}
                      className="rounded border border-orange-500/30 bg-orange-950/30 px-2 py-0.5 font-mono text-[11px] text-orange-200"
                    >
                      {effId}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2 text-xs">
              <label className="block space-y-1">
                <span className="font-medium text-slate-300">Escopo de partículas e poderes</span>
                <select
                  disabled={Boolean(completeExportProgress)}
                  value={completeEffectScope}
                  onChange={(e) => setCompleteEffectScope(e.target.value as EffectIncludeScope)}
                  className="w-full rounded-md border border-slate-800 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="powers">Com poderes (partículas no ninja e tela — recomendado)</option>
                  <option value="all">Completa (+ efeitos de impacto no alvo)</option>
                  <option value="base">Somente ninja (sem partículas)</option>
                </select>
              </label>

              <div className="space-y-2 pt-1">
                <span className="block font-medium text-slate-300">O que incluir na pasta do personagem</span>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeOriginals}
                    onChange={(e) => setCompleteIncludeOriginals(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Originais + Frames Fatiados
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui <code className="font-mono">.atlas</code>, <code className="font-mono">.json</code>, folha original e pasta <code className="font-mono">frames/*.png</code>.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeEffects}
                    onChange={(e) => setCompleteIncludeEffects(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Pacotes de Partículas + Instruções JSON
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui <code className="font-mono">particulas/&lt;efeito&gt;/</code> e <code className="font-mono">animacoes_instrucoes.json</code> mapeando cada animação e tempo de disparo.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeAnimPngs}
                    onChange={(e) => setCompleteIncludeAnimPngs(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Todas as Animações: Sequência PNG + Spritesheet (Qualidade Máxima 1:1 · 24 FPS)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Renderiza cada animação em resolução nativa 1:1 sem perda, já composta com as partículas em <code className="font-mono">animacoes/&lt;anim&gt;/</code>.
                    </div>
                  </div>
                </label>

                <div className="rounded-md border border-slate-800 bg-[#0B0F17] p-2.5 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludeAnimGifs}
                      onChange={(e) => setCompleteIncludeAnimGifs(e.target.checked)}
                      className="mt-0.5 accent-emerald-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Todas as Animações em GIF Animado
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Gera <code className="font-mono">&lt;anim&gt;.gif</code> já com os poderes para cada animação.
                      </div>
                    </div>
                  </label>

                  {completeIncludeAnimGifs && (
                    <div className="flex items-center justify-between gap-2 pl-6">
                      <span className="text-[11px] text-slate-400">Fundo dos GIFs:</span>
                      <select
                        disabled={Boolean(completeExportProgress)}
                        value={completeGifBg}
                        onChange={(e) =>
                          setCompleteGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        className="rounded border border-slate-800 bg-[#131A26] px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="transparent">Sem fundo (transparente)</option>
                        <option value="dark">Fundo escuro</option>
                        <option value="light">Fundo claro</option>
                        <option value="chroma">Chroma verde</option>
                      </select>
                    </div>
                  )}
                </div>

                {mediaProfile?.passiveAura && (
                  <label className="flex items-start gap-2.5 rounded-md border border-purple-500/35 bg-purple-950/15 p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludePassiveAura}
                      onChange={(e) => setCompleteIncludePassiveAura(e.target.checked)}
                      className="mt-0.5 accent-purple-500"
                    />
                    <div>
                      <div className="font-medium text-purple-100">
                        Aura Passiva no Idle ({mediaProfile.passiveAura.label})
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Inclui o pacote <code className="font-mono text-purple-300">{mediaProfile.passiveAura.id}</code> em <code className="font-mono">particulas/</code> e compõe a aura automaticamente nos frames e GIF do <code className="font-mono">idle</code>.
                      </div>
                    </div>
                  </label>
                )}

                <label className="flex items-start gap-2.5 rounded-md border border-amber-500/35 bg-amber-950/15 p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeSkillIcons}
                    onChange={(e) => setCompleteIncludeSkillIcons(e.target.checked)}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div>
                    <div className="font-medium text-amber-100">
                      Ícones das Skills e Passivas (Qualidade Máxima PNG)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui pasta <code className="font-mono">icones_skills/*.png</code> ({skillIconCount} ícone(s) de habilidades ativas e passivas).
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 rounded-md border border-cyan-500/35 bg-cyan-950/15 p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeVideosAndAudio}
                    onChange={(e) => setCompleteIncludeVideosAndAudio(e.target.checked)}
                    className="mt-0.5 accent-cyan-500"
                  />
                  <div>
                    <div className="font-medium text-cyan-100">
                      Vídeos da Ultimate (MP4) + Vozes e Efeitos Sonoros (MP3)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Inclui pasta <code className="font-mono">videos/*.mp4</code> ({mediaProfile?.videos.length || 0} vídeo(s)) e pasta <code className="font-mono">audios/</code> ({mediaProfile?.voices.length || 0} voz(es) + sons das habilidades).
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {completeExportProgress && (
              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="truncate text-slate-200">{completeExportProgress.message}</span>
                  <span className="ml-2 shrink-0 text-emerald-400">
                    {completeExportProgress.percent}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-150"
                    style={{ width: `${completeExportProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {completeExportError && (
              <div
                role="alert"
                className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200"
              >
                {completeExportError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              {completeExportProgress ? (
                <button
                  type="button"
                  onClick={() => completeExportAbortRef.current?.abort()}
                  className="rounded-lg border border-red-700/70 bg-red-950/40 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/50 cursor-pointer"
                >
                  Cancelar
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowCompleteExportModal(false)}
                    className="rounded-lg border border-slate-700 bg-[#0B0F17] px-4 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    disabled={
                      !completeIncludeOriginals &&
                      !completeIncludeEffects &&
                      !completeIncludeAnimPngs &&
                      !completeIncludeAnimGifs &&
                      !completeIncludeVideosAndAudio
                    }
                    onClick={() => void handleRunCompleteCharacterExport()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Baixar {ninja.id}_completo.zip</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
