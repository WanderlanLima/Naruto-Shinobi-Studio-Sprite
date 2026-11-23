import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  Clapperboard,
  Copy,
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
  Terminal,
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
  buildCharacterCombatJson,
  buildCharacterInstructionsJson,
  collectCharacterEffectPlan,
  collectCharacterSkillIconFiles,
  exportCompleteCharacterZip,
  getOrderedSkillIconTargets,
  sanitizePathSegment,
  type EffectIncludeScope,
} from '../utils/completeCharacterExporter';
import { stripHtmlTags } from '../utils/combatMechanicsParser';
import {
  clearExportCheckpoint,
  getLatestExportCheckpoint,
  type ExportCheckpointJobMeta,
} from '../utils/exportCheckpointStore';
import {
  fetchNinjaBundle,
  fetchNinjaMediaProfile,
  resolveAssetFetchUrl,
  resolveMediaPlayUrl,
  resolveMediaSoundUrl,
  resolveMediaVideoUrl,
} from '../utils/remoteClient';
import { assembleStreamingZipBlob, computeCrc32, type StreamingZipEntry } from '../utils/streamingZip';
import { downloadTermuxCharacterExportScript } from '../utils/termuxCharacterExportScript';

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

const STUDIO_PREFS_STORAGE_KEY = 'shinobi_studio_prefs_v1';

interface SavedStudioPrefs {
  bgStyle: BgStyle;
  effectMode: 'powers' | 'all' | 'base';
  gifBg: 'transparent' | 'dark' | 'light' | 'chroma';
  soundMuted: boolean;
  soundVolume: number;
  enableVideoCutscene: boolean;
  completeEffectScope: EffectIncludeScope;
  completeIncludeOriginals: boolean;
  completeIncludeEffects: boolean;
  completeIncludeAnimPngs: boolean;
  completeIncludeAnimGifs: boolean;
  completeIncludePassiveAura: boolean;
  completeIncludeVideosAndAudio: boolean;
  completeIncludeSkillIcons: boolean;
  completeIncludeArtworks: boolean;
  completeGifBg: 'transparent' | 'dark' | 'light' | 'chroma';
  completeExportFps: 24 | 15 | 12;
  completeExportMaxRes: 2048 | 1024 | 512;
}

const DEFAULT_STUDIO_PREFS: SavedStudioPrefs = {
  bgStyle: 'checker',
  effectMode: 'powers',
  gifBg: 'transparent',
  soundMuted: false,
  soundVolume: 0.85,
  enableVideoCutscene: true,
  completeEffectScope: 'powers',
  completeIncludeOriginals: true,
  completeIncludeEffects: true,
  completeIncludeAnimPngs: true,
  completeIncludeAnimGifs: true,
  completeIncludePassiveAura: true,
  completeIncludeVideosAndAudio: true,
  completeIncludeSkillIcons: true,
  completeIncludeArtworks: true,
  completeGifBg: 'transparent',
  completeExportFps: 24,
  completeExportMaxRes: 2048,
};

function loadStudioPrefs(): SavedStudioPrefs {
  try {
    const raw = localStorage.getItem(STUDIO_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_STUDIO_PREFS;
    const p = JSON.parse(raw) as Partial<SavedStudioPrefs>;
    const validBg = ['checker', 'dark', 'light', 'chroma'] as const;
    const validGif = ['transparent', 'dark', 'light', 'chroma'] as const;
    const validEff = ['powers', 'all', 'base'] as const;
    const validFps = [24, 15, 12] as const;
    const validRes = [2048, 1024, 512] as const;
    return {
      bgStyle: validBg.includes(p.bgStyle as (typeof validBg)[number])
        ? (p.bgStyle as BgStyle)
        : DEFAULT_STUDIO_PREFS.bgStyle,
      effectMode: validEff.includes(p.effectMode as (typeof validEff)[number])
        ? (p.effectMode as 'powers' | 'all' | 'base')
        : DEFAULT_STUDIO_PREFS.effectMode,
      gifBg: validGif.includes(p.gifBg as (typeof validGif)[number])
        ? (p.gifBg as SavedStudioPrefs['gifBg'])
        : DEFAULT_STUDIO_PREFS.gifBg,
      soundMuted: typeof p.soundMuted === 'boolean' ? p.soundMuted : DEFAULT_STUDIO_PREFS.soundMuted,
      soundVolume:
        typeof p.soundVolume === 'number' && Number.isFinite(p.soundVolume)
          ? Math.max(0, Math.min(1, p.soundVolume))
          : DEFAULT_STUDIO_PREFS.soundVolume,
      enableVideoCutscene:
        typeof p.enableVideoCutscene === 'boolean'
          ? p.enableVideoCutscene
          : DEFAULT_STUDIO_PREFS.enableVideoCutscene,
      completeEffectScope: validEff.includes(p.completeEffectScope as (typeof validEff)[number])
        ? (p.completeEffectScope as EffectIncludeScope)
        : DEFAULT_STUDIO_PREFS.completeEffectScope,
      completeIncludeOriginals:
        typeof p.completeIncludeOriginals === 'boolean'
          ? p.completeIncludeOriginals
          : DEFAULT_STUDIO_PREFS.completeIncludeOriginals,
      completeIncludeEffects:
        typeof p.completeIncludeEffects === 'boolean'
          ? p.completeIncludeEffects
          : DEFAULT_STUDIO_PREFS.completeIncludeEffects,
      completeIncludeAnimPngs:
        typeof p.completeIncludeAnimPngs === 'boolean'
          ? p.completeIncludeAnimPngs
          : DEFAULT_STUDIO_PREFS.completeIncludeAnimPngs,
      completeIncludeAnimGifs:
        typeof p.completeIncludeAnimGifs === 'boolean'
          ? p.completeIncludeAnimGifs
          : DEFAULT_STUDIO_PREFS.completeIncludeAnimGifs,
      completeIncludePassiveAura:
        typeof p.completeIncludePassiveAura === 'boolean'
          ? p.completeIncludePassiveAura
          : DEFAULT_STUDIO_PREFS.completeIncludePassiveAura,
      completeIncludeVideosAndAudio:
        typeof p.completeIncludeVideosAndAudio === 'boolean'
          ? p.completeIncludeVideosAndAudio
          : DEFAULT_STUDIO_PREFS.completeIncludeVideosAndAudio,
      completeIncludeSkillIcons:
        typeof p.completeIncludeSkillIcons === 'boolean'
          ? p.completeIncludeSkillIcons
          : DEFAULT_STUDIO_PREFS.completeIncludeSkillIcons,
      completeIncludeArtworks:
        typeof p.completeIncludeArtworks === 'boolean'
          ? p.completeIncludeArtworks
          : DEFAULT_STUDIO_PREFS.completeIncludeArtworks,
      completeGifBg: validGif.includes(p.completeGifBg as (typeof validGif)[number])
        ? (p.completeGifBg as SavedStudioPrefs['completeGifBg'])
        : DEFAULT_STUDIO_PREFS.completeGifBg,
      completeExportFps: validFps.includes(p.completeExportFps as (typeof validFps)[number])
        ? (p.completeExportFps as 24 | 15 | 12)
        : DEFAULT_STUDIO_PREFS.completeExportFps,
      completeExportMaxRes: validRes.includes(p.completeExportMaxRes as (typeof validRes)[number])
        ? (p.completeExportMaxRes as 2048 | 1024 | 512)
        : DEFAULT_STUDIO_PREFS.completeExportMaxRes,
    };
  } catch {
    return DEFAULT_STUDIO_PREFS;
  }
}

export function StudioStage({
  ninja,
  openCompleteExportSignal = 0,
  onBackToCatalog,
  onLoadedFramesChange,
}: StudioStageProps) {
  const initialPrefsRef = useRef<SavedStudioPrefs | null>(null);
  if (!initialPrefsRef.current) {
    initialPrefsRef.current = loadStudioPrefs();
  }
  const initPrefs = initialPrefsRef.current;

  const [stageMode, setStageMode] = useState<StageMode>('player');
  const [bgStyle, setBgStyle] = useState<BgStyle>(initPrefs.bgStyle);
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
  const [inspectorTab, setInspectorTab] = useState<'animations' | 'combat' | 'media' | 'info'>('animations');
  const [animFilter, setAnimFilter] = useState('');
  const [frameFilter, setFrameFilter] = useState('');
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [showAtlasBoxes, setShowAtlasBoxes] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<AtlasRegion | null>(null);
  const [exportingAnim, setExportingAnim] = useState(false);
  const [gifProgress, setGifProgress] = useState<number | null>(null);
  const [gifBg, setGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>(initPrefs.gifBg);

  // Complete character export modal state
  const [showCompleteExportModal, setShowCompleteExportModal] = useState(false);
  const [completeEffectScope, setCompleteEffectScope] = useState<EffectIncludeScope>(
    initPrefs.completeEffectScope
  );
  const [completeIncludeOriginals, setCompleteIncludeOriginals] = useState(
    initPrefs.completeIncludeOriginals
  );
  const [completeIncludeEffects, setCompleteIncludeEffects] = useState(
    initPrefs.completeIncludeEffects
  );
  const [completeIncludeAnimPngs, setCompleteIncludeAnimPngs] = useState(
    initPrefs.completeIncludeAnimPngs
  );
  const [completeIncludeAnimGifs, setCompleteIncludeAnimGifs] = useState(
    initPrefs.completeIncludeAnimGifs
  );
  const [completeIncludePassiveAura, setCompleteIncludePassiveAura] = useState(
    initPrefs.completeIncludePassiveAura
  );
  const [completeIncludeVideosAndAudio, setCompleteIncludeVideosAndAudio] = useState(
    initPrefs.completeIncludeVideosAndAudio
  );
  const [completeIncludeSkillIcons, setCompleteIncludeSkillIcons] = useState(
    initPrefs.completeIncludeSkillIcons
  );
  const [completeIncludeArtworks, setCompleteIncludeArtworks] = useState(
    initPrefs.completeIncludeArtworks
  );
  const [downloadingSkillIconsZip, setDownloadingSkillIconsZip] = useState(false);
  const [downloadingBaseFramesZip, setDownloadingBaseFramesZip] = useState(false);
  const [completeGifBg, setCompleteGifBg] = useState<'transparent' | 'dark' | 'light' | 'chroma'>(
    initPrefs.completeGifBg
  );
  const [completeExportFps, setCompleteExportFps] = useState<24 | 15 | 12>(
    initPrefs.completeExportFps
  );
  const [completeExportMaxRes, setCompleteExportMaxRes] = useState<2048 | 1024 | 512>(
    initPrefs.completeExportMaxRes
  );
  const [completeExportProgress, setCompleteExportProgress] = useState<{
    phase: string;
    message: string;
    percent: number;
  } | null>(null);
  const [completeExportError, setCompleteExportError] = useState<string | null>(null);
  const [ninjaCheckpoint, setNinjaCheckpoint] = useState<ExportCheckpointJobMeta | null>(null);
  const [termuxExportResult, setTermuxExportResult] = useState<{
    scriptFilename: string;
    zipFilename: string;
    command: string;
  } | null>(null);
  const [copiedTermuxExportCmd, setCopiedTermuxExportCmd] = useState(false);
  const completeExportAbortRef = useRef<AbortController | null>(null);

  const [effectMode, setEffectMode] = useState<'powers' | 'all' | 'base'>(initPrefs.effectMode);
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
  const [soundMuted, setSoundMuted] = useState(initPrefs.soundMuted);
  const [soundVolume, setSoundVolume] = useState(initPrefs.soundVolume);
  const [playingVoiceKey, setPlayingVoiceKey] = useState<string | null>(null);
  const [enableVideoCutscene, setEnableVideoCutscene] = useState(initPrefs.enableVideoCutscene);
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

  // Persist Studio & Export preferences whenever any preference changes
  useEffect(() => {
    try {
      const prefs: SavedStudioPrefs = {
        bgStyle,
        effectMode,
        gifBg,
        soundMuted,
        soundVolume,
        enableVideoCutscene,
        completeEffectScope,
        completeIncludeOriginals,
        completeIncludeEffects,
        completeIncludeAnimPngs,
        completeIncludeAnimGifs,
        completeIncludePassiveAura,
        completeIncludeVideosAndAudio,
        completeIncludeSkillIcons,
        completeIncludeArtworks,
        completeGifBg,
        completeExportFps,
        completeExportMaxRes,
      };
      localStorage.setItem(STUDIO_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore storage errors
    }
  }, [
    bgStyle,
    effectMode,
    gifBg,
    soundMuted,
    soundVolume,
    enableVideoCutscene,
    completeEffectScope,
    completeIncludeOriginals,
    completeIncludeEffects,
    completeIncludeAnimPngs,
    completeIncludeAnimGifs,
    completeIncludePassiveAura,
    completeIncludeVideosAndAudio,
    completeIncludeSkillIcons,
    completeIncludeArtworks,
    completeGifBg,
    completeExportFps,
    completeExportMaxRes,
  ]);

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

  const ninjaKeyId = ninja?.id || '';
  const ninjaKeyAtlasUrl = ninja?.atlasUrl || '';
  const ninjaKeySkeletonUrl = ninja?.skeletonUrl || '';

  useEffect(() => {
    if (!ninjaKeyId) {
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
    setTermuxExportResult(null);
    setCopiedTermuxExportCmd(false);
    // Never abort or dismiss an actively running export if catalog references refresh
    if (!completeExportAbortRef.current) {
      setShowCompleteExportModal(false);
      setCompleteExportProgress(null);
      setCompleteExportError(null);
    }
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

    void getLatestExportCheckpoint(ninjaKeyId).then((cp) => {
      if (!cancelled) setNinjaCheckpoint(cp);
    });

    async function loadBundle() {
      try {
        const data = await fetchNinjaBundle(ninjaKeyAtlasUrl, ninjaKeySkeletonUrl);
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
          ninjaId: ninjaKeyId,
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
  }, [ninjaKeyId, ninjaKeyAtlasUrl, ninjaKeySkeletonUrl, onLoadedFramesChange]);

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
      descPlain?: string;
      iconUrl?: string;
      isPassive: boolean;
      chaseTriggerLabels?: string[];
      causesChaseStateLabels?: string[];
      targetLabel?: string;
      appliedEffects?: string[];
      damageCategories?: string[];
      elements?: string[];
    }> = [];
    const seen = new Set<string>();
    const pushSkill = (k: string, sk: NonNullable<typeof skillsMap[string]>) => {
      const plain = sk.descPlain || (sk.desc ? stripHtmlTags(sk.desc) : undefined);
      result.push({
        key: `active_${k}`,
        animKey: sk.animKey,
        slotLabel: sk.slotLabel,
        name: sk.name,
        desc: sk.desc,
        descPlain: plain,
        iconUrl: sk.iconUrl,
        isPassive: false,
        chaseTriggerLabels: sk.chaseTriggerLabels,
        causesChaseStateLabels: sk.causesChaseStateLabels,
        targetLabel: sk.targetLabel,
        appliedEffects: sk.appliedEffects,
        damageCategories: sk.damageCategories,
        elements: sk.elements,
      });
    };
    for (const k of order) {
      const sk = skillsMap[k];
      if (!sk) continue;
      seen.add(k);
      pushSkill(k, sk);
    }
    for (const [k, sk] of Object.entries(skillsMap)) {
      if (seen.has(k) || !sk) continue;
      pushSkill(k, sk);
    }
    for (const p of mediaProfile?.passives || []) {
      const plain = p.descPlain || (p.desc ? stripHtmlTags(p.desc) : undefined);
      result.push({
        key: `passive_${p.id}`,
        slotLabel: 'Passiva',
        name: p.name,
        desc: p.desc,
        descPlain: plain,
        iconUrl: p.iconUrl,
        isPassive: true,
        chaseTriggerLabels: p.chaseTriggerLabels,
        causesChaseStateLabels: p.causesChaseStateLabels,
        appliedEffects: p.appliedEffects,
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

  const handleRunCompleteCharacterExport = async (resumeFromCheckpoint = true) => {
    if (!ninja) return;
    const controller = new AbortController();
    completeExportAbortRef.current = controller;
    setCompleteExportError(null);
    setCompleteExportProgress({
      phase: 'base',
      message: resumeFromCheckpoint && ninjaCheckpoint
        ? 'Retomando exportação salva...'
        : 'Iniciando empacotamento completo...',
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
          includeCharacterArtworks: completeIncludeArtworks,
          mediaProfile,
          gifBg: completeGifBg,
          fps: completeExportFps,
          maxResolution: completeExportMaxRes,
          enableCheckpoint: true,
          resumeFromCheckpoint,
          signal: controller.signal,
          onProgress: (info) => setCompleteExportProgress(info),
        }
      );
      setNinjaCheckpoint(null);
      setShowCompleteExportModal(false);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setCompleteExportError(
          err instanceof Error ? err.message : 'Erro ao exportar personagem completo.'
        );
      }
      void getLatestExportCheckpoint(ninja.id).then((cp) => setNinjaCheckpoint(cp));
    } finally {
      completeExportAbortRef.current = null;
      setCompleteExportProgress(null);
    }
  };

  const handleDownloadTermuxCharacterExport = () => {
    if (!ninja) return;
    const result = downloadTermuxCharacterExportScript({
      ninja,
      skeleton,
      mediaProfile,
      effectScope: completeEffectScope,
      includeOriginalAndFrames: completeIncludeOriginals,
      includeLinkedEffects: completeIncludeEffects,
      includeAnimPngsAndSheets: completeIncludeAnimPngs,
      includeAnimGifs: completeIncludeAnimGifs,
      includePassiveAura: completeIncludePassiveAura,
      includeVideosAndAudio: completeIncludeVideosAndAudio,
      includeSkillIcons: completeIncludeSkillIcons,
      includeCharacterArtworks: completeIncludeArtworks,
      gifBg: completeGifBg,
      fps: completeExportFps,
      maxResolution: completeExportMaxRes,
    });
    setTermuxExportResult(result);
    setCopiedTermuxExportCmd(false);
  };

  const handleCopyTermuxCommand = () => {
    if (!termuxExportResult?.command) return;
    try {
      void navigator.clipboard.writeText(termuxExportResult.command).then(() => {
        setCopiedTermuxExportCmd(true);
        setTimeout(() => setCopiedTermuxExportCmd(false), 2000);
      });
    } catch {
      // ignore clipboard errors
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

  const handleDownloadCombatJson = () => {
    if (!ninja || !mediaProfile) return;
    const jsonStr = buildCharacterCombatJson(ninja.id, mediaProfile);
    if (!jsonStr) return;
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `${ninja.id}_combate_e_habilidades.json`);
  };

  const handleDownloadAllSkillIconsZip = async () => {
    if (!ninja || !mediaProfile || downloadingSkillIconsZip) return;
    setDownloadingSkillIconsZip(true);
    try {
      const iconFiles = await collectCharacterSkillIconFiles(mediaProfile);
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
      const combatJson = buildCharacterCombatJson(ninja.id, mediaProfile);
      if (combatJson) {
        const combatBytes = new TextEncoder().encode(combatJson);
        entries.push({
          path: 'combate_e_habilidades.json',
          blob: new Blob([combatBytes as Uint8Array<ArrayBuffer>], { type: 'application/json' }),
          size: combatBytes.byteLength,
          crc32: computeCrc32(combatBytes),
        });
      }
      if (entries.length === 0) return;
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
        const combatJson = buildCharacterCombatJson(ninja.id, mediaProfile);
        if (combatJson) {
          extraFiles.push({
            path: 'combate_e_habilidades.json',
            data: combatJson,
          });
        }
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
          className="mt-5 inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
        >
          Voltar ao catálogo
        </button>
      </div>
    );
  }

  const mediaCount =
    (mediaProfile?.passiveAura ? 1 : 0) +
    (mediaProfile?.videos.length || 0) +
    (mediaProfile?.voices.length || 0);

  return (
    <section className="space-y-4">
      {/* Studio Sub-header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackToCatalog}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-white/25 hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Catálogo</span>
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h1 className="truncate font-display text-lg sm:text-xl font-bold tracking-tight text-slate-50">
                {mediaProfile?.displayName || ninja.name || ninja.id}
              </h1>
              {(mediaProfile?.displayName || ninja.name) && (
                <span className="font-mono text-xs text-slate-500">{ninja.id}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono tabular-nums truncate">
              {ninja.width} × {ninja.height} px · {frames.length} frames · {animNames.length} animações
              {mediaProfile?.combatProfile?.natureLabel ? ` · ${mediaProfile.combatProfile.natureLabel}` : ''}
            </p>
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#11141C] p-1">
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
            <span>Player</span>
          </button>
          <button
            type="button"
            onClick={() => setStageMode('frames')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
              stageMode === 'frames'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Grid className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Frames ({frames.length})</span>
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
            <span>Folha</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex h-80 items-center justify-center rounded-xl border border-white/[0.07] bg-[#11141C]">
          <div className="text-center">
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-orange-500" />
            <p className="mt-3 text-xs text-slate-400">
              Carregando {ninja.name || ninja.id}...
            </p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-red-500/30 bg-red-950/25 p-5 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && frames.length > 0 && !skeleton && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">
          Frames e folha original carregados. Configure um proxy nas opções de Fonte do Catálogo para reproduzir animações Spine neste domínio.
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
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
                      ? 'fixed inset-0 z-50 overflow-y-auto bg-[#090B10]/96 p-3 sm:p-6 backdrop-blur-xs'
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
                    className={`rounded-xl border border-white/[0.08] bg-[#11141C] ${
                      playerDetached
                        ? 'mx-auto my-2 w-full max-w-6xl shadow-2xl'
                        : 'overflow-hidden'
                    }`}
                  >
                    {playerDetached && (
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-xl border-b border-white/[0.07] bg-[#0D1017] px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5 text-xs">
                          {selectedAnimMeta.iconUrl && (
                            <img
                              src={resolveAssetFetchUrl(selectedAnimMeta.iconUrl)}
                              alt={selectedAnimMeta.shortLabel || selectedAnim}
                              className="h-7 w-7 shrink-0 rounded border border-white/10 bg-[#090B10] object-contain"
                            />
                          )}
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate font-display font-semibold text-slate-100">
                              {mediaProfile?.displayName || ninja.name || ninja.id}
                            </span>
                            <span className="text-slate-600" aria-hidden="true">·</span>
                            <span className="truncate font-mono text-orange-400">
                              {selectedAnim}
                            </span>
                            {selectedAnimMeta.shortLabel && (
                              <span className="truncate text-slate-400">
                                {selectedAnimMeta.shortLabel}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={closeDetachedPlayer}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#11141C] px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Fechar</span>
                        </button>
                      </div>
                    )}

                    {/* Canvas Toolbar */}
                    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-white/[0.07] px-3.5 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#090B10] p-0.5">
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
                              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                bgStyle === bg.id
                                  ? 'bg-white/12 text-white'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {bg.label}
                            </button>
                          ))}
                        </div>

                        {rawEffectRefs.length > 0 && (
                          <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#090B10] p-0.5">
                            {hasSelfPowers && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('powers')}
                                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'powers'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                Poderes
                              </button>
                            )}
                            {hasImpactEffects && (
                              <button
                                type="button"
                                onClick={() => setEffectMode('all')}
                                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  effectMode === 'all'
                                    ? 'bg-orange-600 text-white'
                                    : 'text-slate-400 hover:text-slate-100'
                                }`}
                              >
                                {hasSelfPowers ? 'Completo' : 'Efeitos'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setEffectMode('base')}
                              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                effectMode === 'base'
                                  ? 'bg-white/12 text-white'
                                  : 'text-slate-400 hover:text-slate-100'
                              }`}
                            >
                              Base
                            </button>
                          </div>
                        )}

                        {mediaProfile?.passiveAura && (
                          <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-[#090B10] p-0.5">
                            <button
                              type="button"
                              onClick={() => setShowPassiveAura((v) => !v)}
                              title={mediaProfile.passiveAura.label}
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                showPassiveAura
                                  ? 'bg-white/12 text-slate-100'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <Sparkles className="h-3 w-3 text-purple-400" aria-hidden="true" />
                              <span>Aura</span>
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
                                  aria-label="Fase da aura"
                                  className="rounded bg-transparent px-1.5 py-1 text-[11px] text-slate-300 focus:outline-none cursor-pointer"
                                >
                                  <option value="loop" className="bg-[#090B10]">Contínua</option>
                                  <option value="intro" className="bg-[#090B10]">Entrada</option>
                                  <option value="outro" className="bg-[#090B10]">Saída</option>
                                </select>
                              )}
                          </div>
                        )}

                        {activeVideoRefs.length > 0 && (
                          <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#090B10] p-0.5">
                            <button
                              type="button"
                              onClick={() => setEnableVideoCutscene((v) => !v)}
                              title="Reproduzir vídeo automaticamente durante a animação"
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                enableVideoCutscene
                                  ? 'bg-white/12 text-cyan-200'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <Clapperboard className="h-3 w-3" aria-hidden="true" />
                              <span>Vídeo</span>
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
                                  label: `Ultimate · ${first.resolvedName}`,
                                  key: first.resolvedName,
                                  resumePlaying: isPlaying,
                                });
                              }}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white whitespace-nowrap cursor-pointer"
                            >
                              Assistir
                            </button>
                          </div>
                        )}

                        <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-[#090B10] px-2 py-1">
                          <button
                            type="button"
                            onClick={() => {
                              audioCuePlayer.unlock();
                              setSoundMuted((m) => !m);
                            }}
                            aria-label={soundMuted ? 'Ativar som' : 'Silenciar som'}
                            className={`inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer ${
                              soundMuted
                                ? 'text-slate-500 hover:text-slate-300'
                                : 'text-slate-200 hover:text-white'
                            }`}
                          >
                            {soundMuted ? (
                              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <Volume2 className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
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
                              className="w-12 accent-orange-500 cursor-pointer"
                            />
                          )}
                        </div>

                        {(loadingEffects || loadingPassiveAura) && (
                          <span className="text-[11px] text-slate-400 font-mono whitespace-nowrap">
                            {loadingPassiveAura ? 'Carregando aura...' : 'Carregando efeitos...'}
                          </span>
                        )}
                        {!loadingEffects && effectLoadError && (
                          <span className="text-[11px] text-amber-300 whitespace-nowrap">
                            {effectLoadError}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {(zoom > 1.02 || pan.x !== 0 || pan.y !== 0) && (
                          <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#090B10] p-0.5">
                            <button
                              type="button"
                              onClick={() => setPan((p) => clampPlayerPan(p.x - 24, p.y, zoom))}
                              aria-label="Mover para esquerda"
                              className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPan((p) => clampPlayerPan(p.x, p.y - 24, zoom))}
                              aria-label="Mover para cima"
                              className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <ArrowUp className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPan((p) => clampPlayerPan(p.x, p.y + 24, zoom))}
                              aria-label="Mover para baixo"
                              className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <ArrowDown className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPan((p) => clampPlayerPan(p.x + 24, p.y, zoom))}
                              aria-label="Mover para direita"
                              className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <ArrowRight className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAutoFit(true);
                                setPan({ x: 0, y: 0 });
                              }}
                              title="Centralizar"
                              aria-label="Centralizar"
                              className="rounded p-1 text-slate-300 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <Crosshair className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            setAutoFit(true);
                            setZoom(1);
                            setPan({ x: 0, y: 0 });
                          }}
                          title="Ajustar enquadramento"
                          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Maximize2 className="h-3 w-3" aria-hidden="true" />
                          <span>Ajustar</span>
                        </button>

                        <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#090B10] p-0.5">
                          <button
                            type="button"
                            onClick={() => applyZoom((z) => z - 0.15)}
                            aria-label="Diminuir zoom"
                            className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                          >
                            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <span className="w-10 text-center font-mono text-[11px] text-slate-300 tabular-nums">
                            {Math.round(zoom * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() => applyZoom((z) => z + 0.15)}
                            aria-label="Aumentar zoom"
                            className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                          >
                            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Stage Canvas */}
                    <div
                      className={`${bgClass} relative flex items-center justify-center p-4 ${
                        playerDetached ? 'min-h-[280px]' : ''
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
                <div className="space-y-3 border-t border-white/[0.07] p-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime((t) => Math.max(0, t - 1 / 30));
                      }}
                      aria-label="Frame anterior"
                      className="rounded-lg border border-white/10 bg-[#090B10] p-2 text-slate-300 hover:border-white/25 cursor-pointer"
                    >
                      <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        audioCuePlayer.unlock();
                        setIsPlaying((p) => !p);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
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
                      className="rounded-lg border border-white/10 bg-[#090B10] p-2 text-slate-300 hover:border-white/25 cursor-pointer"
                    >
                      <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
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

                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                    </span>

                    <select
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      aria-label="Velocidade da animação"
                      className="rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 font-mono text-xs text-slate-200 cursor-pointer"
                    >
                      <option value={0.25}>0.25x</option>
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                    <span className="text-[11px] text-slate-500 mr-1">Exportar cena:</span>
                    <button
                      type="button"
                      onClick={handleDownloadCurrentCanvasFrame}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Frame PNG</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportAnimStrip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Spritesheet</span>
                    </button>
                    <div className="inline-flex items-center overflow-hidden rounded-lg border border-white/10 bg-[#090B10]">
                      <select
                        value={gifBg}
                        disabled={exportingAnim || gifProgress !== null}
                        onChange={(e) =>
                          setGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        aria-label="Fundo do GIF"
                        className="border-r border-white/10 bg-transparent px-2 py-1.5 text-xs text-slate-300 focus:outline-none cursor-pointer disabled:opacity-50"
                      >
                        <option value="transparent" className="bg-[#090B10] text-slate-100">
                          Transparente
                        </option>
                        <option value="dark" className="bg-[#090B10] text-slate-100">
                          Escuro
                        </option>
                        <option value="light" className="bg-[#090B10] text-slate-100">
                          Claro
                        </option>
                        <option value="chroma" className="bg-[#090B10] text-slate-100">
                          Chroma
                        </option>
                      </select>
                      <button
                        type="button"
                        disabled={exportingAnim || gifProgress !== null}
                        onClick={() => void handleExportAnimGif()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.06] disabled:opacity-50 cursor-pointer"
                      >
                        <Film className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {gifProgress !== null ? `GIF ${gifProgress}%` : 'GIF'}
                        </span>
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={exportingAnim || gifProgress !== null}
                      onClick={handleExportAnimZip}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/60 hover:text-white disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {exportingAnim ? 'Renderizando...' : 'Frames (ZIP)'}
                      </span>
                    </button>
                  </div>
                </div>
                  </div>
                </div>
              </div>
            )}

            {stageMode === 'frames' && (
              <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <input
                    type="search"
                    value={frameFilter}
                    onChange={(e) => setFrameFilter(e.target.value)}
                    placeholder="Filtrar frame..."
                    className="w-60 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={downloadingBaseFramesZip}
                    onClick={() => void handleDownloadBaseFramesZip()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-orange-500/60 hover:text-white disabled:opacity-50 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {downloadingBaseFramesZip
                        ? 'Compactando...'
                        : `Baixar frames (${frames.length}) ZIP`}
                    </span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {filteredFrames.map((frame) => (
                    <div
                      key={frame.id}
                      className="flex flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-[#090B10]"
                    >
                      <div className="sprite-checkerboard flex h-28 items-center justify-center p-2">
                        <img
                          src={frame.dataUrl}
                          alt={frame.name}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-2.5 py-2">
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
                          className="rounded p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
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
                      className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#11141C]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
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

          {/* Right Tabbed Inspector Sidebar */}
          <aside className="rounded-xl border border-white/[0.07] bg-[#11141C] flex flex-col overflow-hidden h-fit">
            {/* Inspector Tabs */}
            <div className="grid grid-cols-4 border-b border-white/[0.07] bg-[#0D1017] text-xs font-medium">
              {(
                [
                  { id: 'animations', label: 'Animações', count: animNames.length },
                  { id: 'combat', label: 'Skills', count: orderedSkillList.length },
                  { id: 'media', label: 'Mídia', count: mediaCount },
                  { id: 'info', label: 'Info', count: null },
                ] as const
              ).map((t) => {
                const active = inspectorTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setInspectorTab(t.id)}
                    className={`relative py-3 text-center transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                      active ? 'text-slate-50 font-semibold' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>{t.label}</span>
                    {t.count !== null && t.count > 0 && (
                      <span className="ml-1 font-mono text-[10px] text-slate-500">{t.count}</span>
                    )}
                    {active && (
                      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-orange-500" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* TAB 1: ANIMATIONS */}
            {inspectorTab === 'animations' && (
              <div className="p-3.5 space-y-3">
                {animNames.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">
                    Nenhuma animação disponível neste pacote.
                  </p>
                ) : (
                  <>
                    <input
                      type="search"
                      value={animFilter}
                      onChange={(e) => setAnimFilter(e.target.value)}
                      placeholder="Filtrar animação..."
                      aria-label="Filtrar animações"
                      className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                    />
                    <div className="max-h-[480px] divide-y divide-white/[0.05] overflow-y-auto pr-1">
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
                        const cues: string[] = [];
                        if (hasAuraHere) cues.push('Aura');
                        if (hasPowers) cues.push('Poder');
                        else if (hasImpacts) cues.push('Efeito');
                        if (videoRefs.length > 0) cues.push('Vídeo');
                        if (audioRefs.length > 0) cues.push('Som');

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
                            className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-xs transition-colors cursor-pointer rounded-lg ${
                              active
                                ? 'bg-orange-600/90 text-white'
                                : 'text-slate-300 hover:bg-white/[0.04]'
                            }`}
                          >
                            {meta.iconUrl && (
                              <img
                                src={resolveAssetFetchUrl(meta.iconUrl)}
                                alt={meta.shortLabel || anim}
                                loading="lazy"
                                className={`h-8 w-8 shrink-0 rounded border object-contain ${
                                  active
                                    ? 'border-white/30 bg-black/25'
                                    : 'border-white/10 bg-[#090B10]'
                                }`}
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono font-medium">{anim}</span>
                                <span
                                  className={`shrink-0 font-mono text-[10px] tabular-nums ${
                                    active ? 'text-orange-100' : 'text-slate-500'
                                  }`}
                                >
                                  {dur.toFixed(2)}s
                                </span>
                              </div>
                              {(meta.shortLabel || cues.length > 0) && (
                                <div
                                  className={`mt-0.5 truncate text-[11px] ${
                                    active ? 'text-orange-100/90' : 'text-slate-400'
                                  }`}
                                >
                                  {[meta.shortLabel, ...cues].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* TAB 2: COMBAT & SKILLS */}
            {inspectorTab === 'combat' && (
              <div className="p-3.5 space-y-3.5">
                {orderedSkillList.length === 0 && !mediaProfile?.combatProfile ? (
                  <p className="py-6 text-center text-xs text-slate-500">
                    Nenhuma habilidade catalogada para este item.
                  </p>
                ) : (
                  <>
                    {/* Compact Combat Profile & Quick Exports */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-3">
                      <div className="min-w-0 space-y-0.5">
                        {mediaProfile?.combatProfile && (
                          <>
                            <div className="text-xs font-medium text-slate-200 truncate">
                              {[
                                mediaProfile.combatProfile.natureLabel,
                                mediaProfile.combatProfile.combatRoleLabel,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                            <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {[
                                typeof mediaProfile.combatProfile.baseStats?.hp === 'number'
                                  ? `PV ${mediaProfile.combatProfile.baseStats.hp}`
                                  : null,
                                typeof mediaProfile.combatProfile.baseStats?.attack === 'number'
                                  ? `ATQ ${mediaProfile.combatProfile.baseStats.attack}`
                                  : null,
                                typeof mediaProfile.combatProfile.baseStats?.defense === 'number'
                                  ? `DEF ${mediaProfile.combatProfile.baseStats.defense}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {mediaProfile && (
                          <button
                            type="button"
                            onClick={handleDownloadCombatJson}
                            title="Baixar combate_e_habilidades.json"
                            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-orange-500/60 hover:text-white cursor-pointer whitespace-nowrap"
                          >
                            <Download className="h-3 w-3" aria-hidden="true" />
                            <span>JSON</span>
                          </button>
                        )}
                        {skillIconCount > 0 && (
                          <button
                            type="button"
                            disabled={downloadingSkillIconsZip}
                            onClick={() => void handleDownloadAllSkillIconsZip()}
                            title="Baixar ícones das habilidades + JSON"
                            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-orange-500/60 hover:text-white disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            <Download className="h-3 w-3" aria-hidden="true" />
                            <span>{downloadingSkillIconsZip ? '...' : `Ícones (${skillIconCount})`}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {mediaProfile?.combatProfile &&
                      (mediaProfile.combatProfile.chaseComboSummary.initiators.length > 0 ||
                        mediaProfile.combatProfile.chaseComboSummary.chasers.length > 0) && (
                        <div className="space-y-1 border-b border-white/[0.07] pb-3 text-[11px] text-slate-300">
                          {mediaProfile.combatProfile.chaseComboSummary.initiators.length > 0 && (
                            <div>
                              <span className="font-semibold text-orange-400">Causa: </span>
                              <span>
                                {Array.from(
                                  new Set(
                                    mediaProfile.combatProfile.chaseComboSummary.initiators.flatMap(
                                      (i) => i.causesStateLabels || []
                                    )
                                  )
                                ).join(' · ')}
                              </span>
                            </div>
                          )}
                          {mediaProfile.combatProfile.chaseComboSummary.chasers.map((c, idx) => (
                            <div key={`${c.skillId}_${idx}`}>
                              <span className="font-semibold text-emerald-400">Persegue: </span>
                              <span>{(c.requiresStateLabels || []).join('/')}</span>
                              {c.causesStateLabels && c.causesStateLabels.length > 0 && (
                                <span className="text-slate-400">
                                  {' → '}
                                  {c.causesStateLabels.join('/')}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                    <div className="max-h-[420px] divide-y divide-white/[0.06] overflow-y-auto pr-1">
                      {orderedSkillList.map((item) => {
                        const matchedAnim =
                          !item.isPassive && item.animKey
                            ? animNames.find((a) => a === item.animKey) ||
                              animNames.find((a) => a.toLowerCase() === item.animKey!.toLowerCase())
                            : undefined;
                        const iconSrc = item.iconUrl ? resolveAssetFetchUrl(item.iconUrl) : '';
                        const downloadName = `${ninja.id}_${sanitizePathSegment(item.slotLabel)}_${sanitizePathSegment(item.name)}.png`;
                        const cleanDesc = item.descPlain || (item.desc ? stripHtmlTags(item.desc) : '');
                        const metaParts: string[] = [];
                        if (item.chaseTriggerLabels?.length) {
                          metaParts.push(`Persegue ${item.chaseTriggerLabels.join('/')}`);
                        }
                        if (item.causesChaseStateLabels?.length) {
                          metaParts.push(`Causa ${item.causesChaseStateLabels.join('/')}`);
                        }
                        if (item.targetLabel) metaParts.push(item.targetLabel);
                        if (item.appliedEffects?.length) {
                          metaParts.push(item.appliedEffects.slice(0, 3).join(', '));
                        }

                        return (
                          <div
                            key={item.key}
                            className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0 text-xs"
                          >
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-[#090B10]">
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
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-medium text-slate-400">
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
                                    className="font-mono text-[10px] text-orange-400 hover:underline cursor-pointer shrink-0"
                                  >
                                    Reproduzir
                                  </button>
                                )}
                              </div>
                              <div className="truncate font-semibold text-slate-100">
                                {item.name}
                              </div>
                              {cleanDesc && (
                                <p className="line-clamp-3 text-[11px] leading-relaxed text-slate-400">
                                  {cleanDesc}
                                </p>
                              )}
                              {metaParts.length > 0 && (
                                <p className="pt-0.5 text-[10px] text-slate-300">
                                  {metaParts.join(' · ')}
                                </p>
                              )}
                            </div>
                            {item.iconUrl && (
                              <button
                                type="button"
                                onClick={() => void handleDownloadRemoteMedia(item.iconUrl!, downloadName)}
                                title="Baixar ícone PNG"
                                aria-label={`Baixar ícone de ${item.name}`}
                                className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* TAB 3: MEDIA (AURA, VIDEOS, VOICES) */}
            {inspectorTab === 'media' && (
              <div className="p-3.5 space-y-4">
                {mediaCount === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">
                    Nenhuma aura, vídeo ou voz vinculada a este item.
                  </p>
                ) : (
                  <>
                    {mediaProfile?.passiveAura && (
                      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] pb-3">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-100 truncate">
                            {mediaProfile.passiveAura.label}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {mediaProfile.passiveAura.id}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowPassiveAura((v) => !v)}
                          className={`rounded-md px-3 py-1 text-xs font-medium cursor-pointer transition-colors ${
                            showPassiveAura
                              ? 'bg-orange-600 text-white'
                              : 'border border-white/10 text-slate-300 hover:border-white/25'
                          }`}
                        >
                          {showPassiveAura ? 'Ativa' : 'Ativar'}
                        </button>
                      </div>
                    )}

                    {mediaProfile && mediaProfile.videos.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-slate-300">
                          Vídeos ({mediaProfile.videos.length})
                        </div>
                        <div className="divide-y divide-white/[0.05]">
                          {mediaProfile.videos.map((vid) => (
                            <div
                              key={vid.key}
                              className="flex items-center justify-between gap-2 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-slate-100">{vid.label}</div>
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
                                  aria-label={`Assistir ${vid.label}`}
                                  className="rounded-md border border-white/10 bg-[#090B10] p-1.5 text-slate-200 hover:border-orange-500/60 hover:text-white cursor-pointer"
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
                                  aria-label={`Baixar ${vid.label}`}
                                  className="rounded-md border border-white/10 bg-[#090B10] p-1.5 text-slate-300 hover:border-white/25 hover:text-white cursor-pointer"
                                >
                                  <Download className="h-3 w-3" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {mediaProfile && mediaProfile.voices.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                          <Music className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                          <span>Vozes ({mediaProfile.voices.length})</span>
                        </div>
                        <div className="max-h-64 divide-y divide-white/[0.05] overflow-y-auto pr-1">
                          {mediaProfile.voices.map((voice) => {
                            const isPlayingThis = playingVoiceKey === voice.key;
                            return (
                              <div
                                key={`${voice.category}_${voice.key}`}
                                className="flex items-center justify-between gap-2 py-2 text-xs"
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
                                    aria-label={isPlayingThis ? 'Parar voz' : 'Ouvir voz'}
                                    className={`rounded-md p-1.5 cursor-pointer ${
                                      isPlayingThis
                                        ? 'bg-orange-600 text-white'
                                        : 'border border-white/10 bg-[#090B10] text-slate-200 hover:border-white/25'
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
                                    aria-label={`Baixar ${voice.label}`}
                                    className="rounded-md border border-white/10 bg-[#090B10] p-1.5 text-slate-300 hover:border-white/25 hover:text-white cursor-pointer"
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
                  </>
                )}
              </div>
            )}

            {/* TAB 4: INFO / SPECS */}
            {inspectorTab === 'info' && (
              <div className="p-4">
                <dl className="divide-y divide-white/[0.06] text-xs">
                  <div className="flex justify-between gap-2 py-2.5 first:pt-0">
                    <dt className="text-slate-400">Identificador</dt>
                    <dd className="font-mono text-slate-100">{ninja.id}</dd>
                  </div>
                  <div className="flex justify-between gap-2 py-2.5">
                    <dt className="text-slate-400">Dimensão base</dt>
                    <dd className="font-mono text-slate-100 tabular-nums">
                      {ninja.width} × {ninja.height} px
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2 py-2.5">
                    <dt className="text-slate-400">Frames</dt>
                    <dd className="font-mono text-slate-100 tabular-nums">{frames.length}</dd>
                  </div>
                  <div className="flex justify-between gap-2 py-2.5">
                    <dt className="text-slate-400">Animações</dt>
                    <dd className="font-mono text-slate-100 tabular-nums">{animNames.length}</dd>
                  </div>
                  <div className="flex justify-between gap-2 py-2.5">
                    <dt className="text-slate-400">Folhas</dt>
                    <dd className="font-mono text-slate-100 tabular-nums">{pages.length}</dd>
                  </div>
                  <div className="flex justify-between gap-2 py-2.5 last:pb-0">
                    <dt className="text-slate-400">Versão Spine</dt>
                    <dd className="font-mono text-slate-100 tabular-nums">
                      {skeleton?.skeleton?.spine || '—'}
                    </dd>
                  </div>
                </dl>
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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget && !completeExportProgress) {
              setShowCompleteExportModal(false);
            }
          }}
        >
          <div className="w-full max-w-lg rounded-xl border border-white/10 bg-[#11141C] p-5 space-y-4 max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] pb-3.5">
              <div>
                <h3
                  id="complete-char-export-title"
                  className="font-display text-base font-semibold text-slate-50"
                >
                  Exportar personagem ({mediaProfile?.displayName || ninja.name || ninja.id})
                </h3>
                <p className="mt-0.5 font-mono text-xs text-slate-400 tabular-nums">
                  {frames.length} frames · {animNames.length} animações ·{' '}
                  {completeEffectPlan.uniqueSpineIds.length} efeitos
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(completeExportProgress)}
                onClick={() => setShowCompleteExportModal(false)}
                aria-label="Fechar"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <label className="block space-y-1.5">
                <span className="font-medium text-slate-300">Camadas de efeitos</span>
                <select
                  disabled={Boolean(completeExportProgress)}
                  value={completeEffectScope}
                  onChange={(e) => setCompleteEffectScope(e.target.value as EffectIncludeScope)}
                  className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
                >
                  <option value="powers">Com poderes (recomendado)</option>
                  <option value="all">Completo (poderes + impactos)</option>
                  <option value="base">Somente personagem</option>
                </select>
              </label>

              <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#090B10]">
                <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeOriginals}
                    onChange={(e) => setCompleteIncludeOriginals(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">Arquivos originais e frames</div>
                    <div className="text-[11px] text-slate-400">
                      Esqueleto Spine, folhas originais e frames individuais em PNG.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeEffects}
                    onChange={(e) => setCompleteIncludeEffects(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">Partículas, combate e instruções</div>
                    <div className="text-[11px] text-slate-400">
                      Pacotes de partículas, roteiro de animações e ficha completa de skills/perseguições em JSON.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeAnimPngs}
                    onChange={(e) => setCompleteIncludeAnimPngs(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">Sequências PNG e spritesheets</div>
                    <div className="text-[11px] text-slate-400">
                      Todas as animações renderizadas em passagem única ({completeExportFps} FPS) com efeitos compostos.
                    </div>
                  </div>
                </label>

                <div className="p-3 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludeAnimGifs}
                      onChange={(e) => setCompleteIncludeAnimGifs(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">GIFs animados</div>
                      <div className="text-[11px] text-slate-400">
                        Um arquivo GIF pronto para cada animação.
                      </div>
                    </div>
                  </label>
                  {completeIncludeAnimGifs && (
                    <div className="flex items-center justify-between gap-2 pl-6">
                      <span className="text-[11px] text-slate-400">Fundo dos GIFs</span>
                      <select
                        disabled={Boolean(completeExportProgress)}
                        value={completeGifBg}
                        onChange={(e) =>
                          setCompleteGifBg(
                            e.target.value as 'transparent' | 'dark' | 'light' | 'chroma'
                          )
                        }
                        className="rounded-md border border-white/10 bg-[#11141C] px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="transparent">Transparente</option>
                        <option value="dark">Escuro</option>
                        <option value="light">Claro</option>
                        <option value="chroma">Chroma verde</option>
                      </select>
                    </div>
                  )}
                </div>

                {(completeIncludeAnimPngs || completeIncludeAnimGifs) && (
                  <div className="grid grid-cols-2 gap-2.5 p-3 bg-white/[0.015]">
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-400">Taxa de quadros</span>
                      <select
                        disabled={Boolean(completeExportProgress)}
                        value={completeExportFps}
                        onChange={(e) =>
                          setCompleteExportFps(Number(e.target.value) as 24 | 15 | 12)
                        }
                        className="w-full rounded-md border border-white/10 bg-[#11141C] px-2 py-1.5 text-[11px] text-slate-200 focus:border-orange-500 focus:outline-none"
                      >
                        <option value={24}>24 FPS (Original)</option>
                        <option value={15}>15 FPS (Mais rápido)</option>
                        <option value={12}>12 FPS (Ultra rápido)</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-slate-400">Resolução máxima</span>
                      <select
                        disabled={Boolean(completeExportProgress)}
                        value={completeExportMaxRes}
                        onChange={(e) =>
                          setCompleteExportMaxRes(Number(e.target.value) as 2048 | 1024 | 512)
                        }
                        className="w-full rounded-md border border-white/10 bg-[#11141C] px-2 py-1.5 text-[11px] text-slate-200 focus:border-orange-500 focus:outline-none"
                      >
                        <option value={2048}>Original (até 2048px)</option>
                        <option value={1024}>Média (até 1024px)</option>
                        <option value={512}>Compacta (até 512px)</option>
                      </select>
                    </label>
                  </div>
                )}

                {mediaProfile?.passiveAura && (
                  <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludePassiveAura}
                      onChange={(e) => setCompleteIncludePassiveAura(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Aura passiva ({mediaProfile.passiveAura.label})
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Inclui o pacote de aura e compõe automaticamente no idle.
                      </div>
                    </div>
                  </label>
                )}

                <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeSkillIcons}
                    onChange={(e) => setCompleteIncludeSkillIcons(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      Ícones das habilidades ({skillIconCount})
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Ícones de skills ativas e passivas em PNG.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={Boolean(completeExportProgress)}
                    checked={completeIncludeVideosAndAudio}
                    onChange={(e) => setCompleteIncludeVideosAndAudio(e.target.checked)}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <div className="font-medium text-slate-100">Vídeos e áudios</div>
                    <div className="text-[11px] text-slate-400">
                      {mediaProfile?.videos.length || 0} vídeo(s) MP4 e {mediaProfile?.voices.length || 0} voz(es)/efeitos MP3.
                    </div>
                  </div>
                </label>

                {ninja.kind !== 'effect' && (
                  <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(completeExportProgress)}
                      checked={completeIncludeArtworks}
                      onChange={(e) => setCompleteIncludeArtworks(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Artes oficiais do ninja (PNG)
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Arte completa, meio corpo, retratos, avatar, close-up, expressões e arte do nome em <span className="font-mono">artes/</span>.
                      </div>
                    </div>
                  </label>
                )}
              </div>
            </div>

            {ninjaCheckpoint && !completeExportProgress && (
              <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2 text-amber-100">
                  <span className="font-medium">
                    Progresso salvo encontrado ({ninjaCheckpoint.completedAnims.length}/
                    {ninjaCheckpoint.totalAnims} animações prontas)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void clearExportCheckpoint(ninjaCheckpoint.jobId).then(() =>
                        setNinjaCheckpoint(null)
                      );
                    }}
                    className="text-[11px] text-amber-300/80 hover:text-amber-100 underline cursor-pointer"
                  >
                    Limpar
                  </button>
                </div>
                <p className="text-[11px] text-amber-200/80">
                  Ao clicar em <span className="font-semibold">Retomar ZIP</span>, o app continua exatamente da animação onde parou.
                </p>
              </div>
            )}

            {termuxExportResult && !completeExportProgress && (
              <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/20 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold text-emerald-200">
                    <Terminal className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Script Termux baixado</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTermuxExportResult(null)}
                    aria-label="Fechar aviso Termux"
                    className="text-emerald-300/70 hover:text-white cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <p className="text-[11px] text-emerald-100/85">
                  Abra o Termux e rode o comando abaixo. Ele detecta automaticamente seu backup{' '}
                  <span className="font-mono">.zip</span> em <span className="font-mono">Downloads</span>,
                  usa todos os núcleos da CPU (não para em segundo plano) e salva{' '}
                  <span className="font-mono text-emerald-200">{termuxExportResult.zipFilename}</span>{' '}
                  idêntico ao navegador em <span className="font-mono">Downloads</span>:
                </p>
                <div className="flex items-center gap-2 rounded-md border border-white/10 bg-[#090B10] px-2.5 py-2">
                  <code className="flex-1 overflow-x-auto font-mono text-[11px] text-emerald-300 whitespace-nowrap">
                    {termuxExportResult.command}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyTermuxCommand}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-600/25 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-600/40 cursor-pointer"
                  >
                    {copiedTermuxExportCmd ? (
                      <>
                        <Check className="h-3 w-3" aria-hidden="true" />
                        <span>Copiado</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" aria-hidden="true" />
                        <span>Copiar</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {completeExportProgress && (
              <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-[#090B10] p-3">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="truncate text-slate-200">{completeExportProgress.message}</span>
                  <span className="ml-2 shrink-0 text-orange-400">
                    {completeExportProgress.percent}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full bg-orange-500 transition-all duration-150"
                    style={{ width: `${completeExportProgress.percent}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  Progresso salvo automaticamente a cada animação concluída.
                </p>
              </div>
            )}

            {completeExportError && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/30 bg-red-950/25 px-3 py-2 text-xs text-red-200"
              >
                {completeExportError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {completeExportProgress ? (
                <button
                  type="button"
                  onClick={() => completeExportAbortRef.current?.abort()}
                  className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-950/60 cursor-pointer"
                >
                  Cancelar
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowCompleteExportModal(false)}
                    className="rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-white/25 cursor-pointer"
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
                      !completeIncludeVideosAndAudio &&
                      !completeIncludeSkillIcons &&
                      !completeIncludeArtworks
                    }
                    onClick={handleDownloadTermuxCharacterExport}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:border-emerald-400/70 hover:bg-emerald-900/50 disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Extrair pelo Termux (.sh)</span>
                  </button>
                  <button
                    type="button"
                    disabled={
                      !completeIncludeOriginals &&
                      !completeIncludeEffects &&
                      !completeIncludeAnimPngs &&
                      !completeIncludeAnimGifs &&
                      !completeIncludeVideosAndAudio &&
                      !completeIncludeSkillIcons &&
                      !completeIncludeArtworks
                    }
                    onClick={() => void handleRunCompleteCharacterExport(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{ninjaCheckpoint ? 'Retomar ZIP' : 'Baixar ZIP'}</span>
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
