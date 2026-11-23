import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Image as ImageIcon,
  Plus,
  Search,
  Sparkles,
  Star,
  Terminal,
  X,
} from 'lucide-react';
import type { ChaseStateCode, NinjaEntry } from '../types/sprite';
import { extractRegionToCanvas, loadImageElement, parseAtlas } from '../utils/atlasParser';
import {
  fetchNinjaBundle,
  getNinjaThumbUrl,
  loadStaticNinjaSkillsPack,
  resolveAssetFetchUrl,
  resolveFallbackPassiveAura,
  resolveStaticNinjaThumbUrl,
} from '../utils/remoteClient';
import {
  getNinjaOfflineCoverage,
  useOfflineZipState,
  type NinjaOfflineCoverage,
} from '../utils/offlineZipStore';
import {
  createCustomTag,
  deleteCustomTag,
  setBulkNinjaTag,
  toggleNinjaFavorite,
  useNinjaCollections,
} from '../utils/ninjaCollectionsStore';
import { TermuxBatchExportModal } from './TermuxBatchExportModal';

interface NinjaCatalogProps {
  ninjas: NinjaEntry[];
  isLoading?: boolean;
  sourceLabel?: string;
  selectedNinjaId: string | null;
  search: string;
  onSearchChange: (val: string) => void;
  kindFilter: 'character' | 'summon_skin' | 'effect' | 'all';
  onKindFilterChange: (kind: 'character' | 'summon_skin' | 'effect' | 'all') => void;
  onlyWithVideo: boolean;
  onOnlyWithVideoChange: (val: boolean) => void;
  sortBy: 'id' | 'name' | 'largest' | 'smallest';
  onSortByChange: (sort: 'id' | 'name' | 'largest' | 'smallest') => void;
  autoThumbnails: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onSelectNinja: (ninja: NinjaEntry) => void;
  onOpenSourceSettings: () => void;
  sourceSettingsOpen?: boolean;
  headerExtra?: ReactNode;
}

type ElementFilter = 'all' | 'fire' | 'lightning' | 'wind' | 'earth' | 'water';
type ChaseFilter = 'all' | ChaseStateCode;
type CollectionFilter = 'all' | 'favorites' | 'exported' | 'not_exported' | `tag:${string}`;

interface CatalogCombatMeta {
  elementKey: Exclude<ElementFilter, 'all'> | null;
  elementLabel: string | null;
  chaseStates: Set<ChaseStateCode>;
}

const ELEMENT_OPTIONS: Array<{ id: ElementFilter; label: string }> = [
  { id: 'all', label: 'Elemento: Todos' },
  { id: 'fire', label: 'Fogo' },
  { id: 'lightning', label: 'Raio' },
  { id: 'wind', label: 'Vento' },
  { id: 'earth', label: 'Terra' },
  { id: 'water', label: 'Água' },
];

const CHASE_OPTIONS: Array<{ id: ChaseFilter; label: string }> = [
  { id: 'all', label: 'Perseguição: Todas' },
  { id: 'fall', label: 'Queda' },
  { id: 'popup', label: 'Flutuação' },
  { id: 'launcher', label: 'Voo Alto' },
  { id: 'back', label: 'Repulsão' },
];

function normalizeElementKey(raw?: string | null): {
  key: Exclude<ElementFilter, 'all'>;
  label: string;
} | null {
  if (!raw) return null;
  const low = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (low.includes('fogo') || low.includes('fire') || low.includes('katon') || low.includes('chama')) {
    return { key: 'fire', label: 'Fogo' };
  }
  if (low.includes('raio') || low.includes('relampago') || low.includes('lightning') || low.includes('raiton') || low.includes('trovao')) {
    return { key: 'lightning', label: 'Raio' };
  }
  if (low.includes('vento') || low.includes('wind') || low.includes('futon')) {
    return { key: 'wind', label: 'Vento' };
  }
  if (low.includes('terra') || low.includes('earth') || low.includes('doton')) {
    return { key: 'earth', label: 'Terra' };
  }
  if (low.includes('agua') || low.includes('water') || low.includes('suiton')) {
    return { key: 'water', label: 'Água' };
  }
  return null;
}

const PAGE_SIZE = 36;

const thumbnailCache = new Map<string, string>();
const inFlightRequests = new Map<string, Promise<string | null>>();
let lastThumbOfflineGeneration = -1;

let activeThumbnailWorkers = 0;
const pendingQueue: Array<() => void> = [];

function runWithConcurrency<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeThumbnailWorkers++;
      try {
        const res = await task();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeThumbnailWorkers--;
        const next = pendingQueue.shift();
        if (next) next();
      }
    };

    if (activeThumbnailWorkers < 2) {
      void execute();
    } else {
      pendingQueue.push(() => {
        void execute();
      });
    }
  });
}

function getSpineKind(ninja: NinjaEntry): 'character' | 'summon_skin' | 'effect' {
  if (ninja.kind) return ninja.kind;
  const lower = ninja.id.toLowerCase();
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

const KIND_LABELS: Record<'character' | 'summon_skin' | 'effect', string> = {
  character: 'Ninja',
  summon_skin: 'Invocação',
  effect: 'Efeito',
};

async function fetchNinjaThumbnail(ninja: NinjaEntry): Promise<string | null> {
  const cached = thumbnailCache.get(ninja.id);
  if (cached) return cached;

  const existing = inFlightRequests.get(ninja.id);
  if (existing) return existing;

  const promise = runWithConcurrency(async () => {
    try {
      const bundle = await fetchNinjaBundle(ninja.atlasUrl, ninja.skeletonUrl);
      const pages = parseAtlas(bundle.atlasText);
      const allRegions = pages.flatMap((p) => p.regions);
      if (allRegions.length === 0) return null;

      const largestRegion = allRegions.reduce(
        (best, r) => (r.width * r.height > best.width * best.height ? r : best),
        allRegions[0]
      );

      let targetRegionName = largestRegion.name;
      const anims = bundle.skeleton?.animations;
      if (anims) {
        const animOrder = ['idle', 'stand', 'animation', 'skill', 'attack', ...Object.keys(anims)];
        for (const animKey of animOrder) {
          const slots = anims[animKey]?.slots;
          if (!slots) continue;
          const slotOrder = [slots.L0, ...Object.values(slots)].filter(Boolean);
          let matched = false;
          for (const slotAnim of slotOrder) {
            const firstAttach = slotAnim?.attachment?.find((a) => typeof a.name === 'string');
            if (firstAttach?.name && allRegions.some((r) => r.name === firstAttach.name)) {
              targetRegionName = firstAttach.name;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }

      const targetRegion =
        allRegions.find((r) => r.name === targetRegionName) || largestRegion;
      const pageProxyUrl = bundle.pageUrls[targetRegion.pageName] || Object.values(bundle.pageUrls)[0];
      if (!pageProxyUrl) return null;

      const img = await loadImageElement(pageProxyUrl);
      const cropped = extractRegionToCanvas(targetRegion, img);

      const thumbCanvas = document.createElement('canvas');
      const maxDim = 144;
      const scale = Math.min(1, maxDim / Math.max(cropped.width, cropped.height));
      thumbCanvas.width = Math.max(1, Math.round(cropped.width * scale));
      thumbCanvas.height = Math.max(1, Math.round(cropped.height * scale));
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) {
        cropped.width = 0;
        cropped.height = 0;
        thumbCanvas.width = 0;
        thumbCanvas.height = 0;
        return null;
      }
      ctx.drawImage(cropped, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const url = thumbCanvas.toDataURL('image/png');
      cropped.width = 0;
      cropped.height = 0;
      thumbCanvas.width = 0;
      thumbCanvas.height = 0;
      thumbnailCache.set(ninja.id, url);
      return url;
    } catch {
      return null;
    } finally {
      inFlightRequests.delete(ninja.id);
    }
  });

  inFlightRequests.set(ninja.id, promise);
  return promise;
}

function NinjaThumbCanvas({
  src,
  alt,
  onError,
}: {
  src: string;
  alt: string;
  onError: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = 160;
      const cssH = 128;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const scale = Math.min(cssW / Math.max(1, img.width), cssH / Math.max(1, img.height));
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const dx = (cssW - drawW) / 2;
      const dy = (cssH - drawH) / 2;
      ctx.drawImage(img, dx, dy, drawW, drawH);
    };
    img.onerror = () => {
      if (!cancelled) onErrorRef.current();
    };
    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={alt}
      role="img"
      className="h-32 w-40 max-h-full max-w-full object-contain transition-transform duration-200 group-hover:scale-105"
    />
  );
}

function NinjaCard({
  ninja,
  isSelected,
  isFavorite,
  isExported,
  selectionMode,
  isChecked,
  elementLabel,
  coverage,
  autoThumbnails,
  offlineGen,
  onSelect,
  onToggleFavorite,
  onToggleChecked,
}: {
  ninja: NinjaEntry;
  isSelected: boolean;
  isFavorite: boolean;
  isExported: boolean;
  selectionMode: boolean;
  isChecked: boolean;
  elementLabel: string | null;
  coverage: NinjaOfflineCoverage | null;
  autoThumbnails: boolean;
  offlineGen: number;
  onSelect: () => void;
  onToggleFavorite: () => void;
  onToggleChecked: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const directThumbUrl = autoThumbnails
    ? getNinjaThumbUrl(ninja.atlasUrl, ninja.skeletonUrl)
    : null;
  const [thumbUrl, setThumbUrl] = useState<string | null>(
    () => thumbnailCache.get(ninja.id) || directThumbUrl
  );
  const [loadingThumb, setLoadingThumb] = useState(false);
  const [nameArtFailed, setNameArtFailed] = useState(false);

  useEffect(() => {
    setNameArtFailed(false);
  }, [ninja.nameArtUrl]);

  useEffect(() => {
    const cached = thumbnailCache.get(ninja.id);
    if (cached) {
      setThumbUrl(cached);
      return;
    }
    if (!autoThumbnails) {
      setThumbUrl(null);
      return;
    }
    if (directThumbUrl) {
      setThumbUrl(directThumbUrl);
      return;
    }

    const el = cardRef.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          setLoadingThumb(true);
          void resolveStaticNinjaThumbUrl(ninja).then((staticUrl) => {
            if (cancelled) return;
            if (staticUrl) {
              thumbnailCache.set(ninja.id, staticUrl);
              setThumbUrl(staticUrl);
              setLoadingThumb(false);
              return;
            }
            void fetchNinjaThumbnail(ninja).then((url) => {
              if (!cancelled) {
                setThumbUrl(url);
                setLoadingThumb(false);
              }
            });
          });
        }
      },
      { rootMargin: '140px' }
    );

    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ninja, autoThumbnails, directThumbUrl, offlineGen]);

  const kind = getSpineKind(ninja);
  const resolvedNameArt =
    ninja.nameArtUrl && !nameArtFailed ? resolveAssetFetchUrl(ninja.nameArtUrl) : null;
  const displayName = ninja.name || ninja.id;

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={() => (selectionMode ? onToggleChecked() : onSelect())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectionMode) onToggleChecked();
          else onSelect();
        }
      }}
      className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
        isChecked
          ? 'border-orange-500 bg-orange-500/[0.08]'
          : isSelected
          ? 'border-orange-500/80 bg-[#151A25]'
          : 'border-white/[0.07] bg-[#11141C] hover:border-white/20'
      }`}
    >
      {/* Top-left selection checkbox when in batch selection mode */}
      {selectionMode && (
        <div
          className={`absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border transition-colors ${
            isChecked
              ? 'border-orange-500 bg-orange-600 text-white'
              : 'border-white/25 bg-[#090B10]/80 text-transparent'
          }`}
          aria-hidden="true"
        >
          <Check className="h-3.5 w-3.5" />
        </div>
      )}

      {/* Top-right favorite star toggle */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={isFavorite ? `Remover ${displayName} dos favoritos` : `Favoritar ${displayName}`}
        aria-pressed={isFavorite}
        className={`absolute right-1.5 top-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-lg transition-colors cursor-pointer ${
          isFavorite
            ? 'bg-[#090B10]/75 text-amber-400 hover:bg-[#090B10]'
            : 'bg-[#090B10]/55 text-slate-500 opacity-85 hover:text-amber-300 group-hover:opacity-100'
        }`}
      >
        <Star className={`h-3.5 w-3.5 ${isFavorite ? 'fill-amber-400' : ''}`} />
      </button>

      <div
        className={`sprite-checkerboard relative flex h-40 sm:h-44 w-full items-center justify-center overflow-hidden border-b border-white/[0.06] px-2.5 pt-2.5 ${
          resolvedNameArt ? 'pb-11' : 'pb-2.5'
        }`}
      >
        {thumbUrl ? (
          <NinjaThumbCanvas
            src={thumbUrl}
            alt={`Sprite ${displayName}`}
            onError={() => {
              if (!thumbUrl.startsWith('data:')) {
                void fetchNinjaThumbnail(ninja).then((fallbackUrl) => {
                  setThumbUrl(fallbackUrl);
                });
              } else {
                setThumbUrl(null);
              }
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-slate-600">
            <ImageIcon className="h-5 w-5" aria-hidden="true" />
            <span className="font-mono text-[11px] tabular-nums">
              {loadingThumb ? '...' : ninja.code}
            </span>
          </div>
        )}

        {resolvedNameArt && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center bg-gradient-to-t from-[#090B10]/85 via-[#090B10]/30 to-transparent px-2 pt-3 pb-1">
            <img
              src={resolvedNameArt}
              alt={displayName}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setNameArtFailed(true)}
              className="max-h-9 w-full object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]"
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        <span
          className="truncate font-display text-xs sm:text-sm font-semibold text-slate-100 group-hover:text-white"
          title={displayName}
        >
          {displayName}
        </span>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate tabular-nums">
          <span className="truncate font-mono text-slate-500">{ninja.id}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{elementLabel || KIND_LABELS[kind]}</span>
          {ninja.hasVideo && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 text-cyan-400">Vídeo</span>
            </>
          )}
        </div>

        {(isExported || coverage) && (
          <div className="flex items-center gap-1.5 text-[10px] truncate tabular-nums pt-0.5">
            {isExported && <span className="shrink-0 text-emerald-400">Exportado</span>}
            {isExported && coverage && (
              <span className="text-slate-600" aria-hidden="true">
                ·
              </span>
            )}
            {coverage && (
              <span
                className={`truncate ${coverage.complete ? 'text-slate-400' : 'text-amber-400'}`}
                title={
                  coverage.complete
                    ? '100% presente no backup offline'
                    : `Falta no backup offline: ${coverage.missing.join(', ')}`
                }
              >
                {coverage.complete
                  ? 'Offline 100%'
                  : `Falta: ${coverage.missing.slice(0, 2).join(', ')}`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function NinjaCatalog({
  ninjas,
  isLoading = false,
  sourceLabel,
  selectedNinjaId,
  search,
  onSearchChange,
  kindFilter,
  onKindFilterChange,
  onlyWithVideo,
  onOnlyWithVideoChange,
  sortBy,
  onSortByChange,
  autoThumbnails,
  page,
  onPageChange,
  onSelectNinja,
  onOpenSourceSettings,
  headerExtra,
}: NinjaCatalogProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const offlineZip = useOfflineZipState();
  const collections = useNinjaCollections();

  // Smart combat & collection filters
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>('all');
  const [elementFilter, setElementFilter] = useState<ElementFilter>('all');
  const [chaseFilter, setChaseFilter] = useState<ChaseFilter>('all');
  const [onlyPassiveAura, setOnlyPassiveAura] = useState(false);

  // Inline custom tag creation
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');

  // Multi-select + Termux batch modal
  const [selectionMode, setSelectionMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [batchModalNinjas, setBatchModalNinjas] = useState<NinjaEntry[] | null>(null);
  const [batchModalLabel, setBatchModalLabel] = useState('Seleção');

  // Combat metadata index loaded once from static pack
  const [combatIndex, setCombatIndex] = useState<Map<string, CatalogCombatMeta>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    void loadStaticNinjaSkillsPack().then((pack) => {
      if (cancelled || !pack) return;
      const map = new Map<string, CatalogCombatMeta>();
      for (const [key, entry] of pack.ninjasLower.entries()) {
        const elRaw =
          entry.combatProfile?.natureLabel ||
          entry.combatProfile?.nature ||
          Object.values(entry.skills || {}).flatMap((s) => s.elements || [])[0] ||
          null;
        const normEl = normalizeElementKey(elRaw);
        const chases = new Set<ChaseStateCode>();
        const addStates = (arr?: ChaseStateCode[]) => {
          if (!arr) return;
          for (const st of arr) chases.add(st);
        };
        for (const sk of Object.values(entry.skills || {})) {
          addStates(sk.chaseTriggers);
          addStates(sk.causesChaseStates);
        }
        for (const p of entry.passives || []) {
          addStates(p.chaseTriggers);
          addStates(p.causesChaseStates);
        }
        for (const init of entry.combatProfile?.chaseComboSummary?.initiators || []) {
          addStates(init.causesStates);
        }
        for (const ch of entry.combatProfile?.chaseComboSummary?.chasers || []) {
          addStates(ch.requiresStates);
          addStates(ch.causesStates);
        }
        map.set(key, {
          elementKey: normEl?.key || null,
          elementLabel: normEl?.label || null,
          chaseStates: chases,
        });
      }
      setCombatIndex(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (lastThumbOfflineGeneration !== offlineZip.generation) {
    lastThumbOfflineGeneration = offlineZip.generation;
    thumbnailCache.clear();
    inFlightRequests.clear();
  }

  const favoriteSet = useMemo(() => new Set(collections.favorites), [collections.favorites]);

  const counts = useMemo(() => {
    let character = 0;
    let summon_skin = 0;
    let effect = 0;
    let withVideo = 0;
    let withAura = 0;
    for (const n of ninjas) {
      const k = getSpineKind(n);
      if (k === 'character') character++;
      else if (k === 'summon_skin') summon_skin++;
      else effect++;
      if (n.hasVideo) withVideo++;
      if (resolveFallbackPassiveAura(n)) withAura++;
    }
    return {
      all: ninjas.length,
      character,
      summon_skin,
      effect,
      withVideo,
      withAura,
      favorites: collections.favorites.length,
      exported: Object.keys(collections.exported).length,
    };
  }, [ninjas, collections.favorites.length, collections.exported]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = ninjas.filter((n) => {
      if (kindFilter !== 'all' && getSpineKind(n) !== kindFilter) return false;
      if (onlyWithVideo && !n.hasVideo) return false;
      if (onlyPassiveAura && !resolveFallbackPassiveAura(n)) return false;

      if (collectionFilter === 'favorites' && !favoriteSet.has(n.id)) return false;
      if (collectionFilter === 'exported' && !collections.exported[n.id]) return false;
      if (collectionFilter === 'not_exported' && collections.exported[n.id]) return false;
      if (collectionFilter.startsWith('tag:')) {
        const tid = collectionFilter.slice(4);
        const assigned = collections.assignments[n.id];
        if (!assigned || !assigned.includes(tid)) return false;
      }

      if (elementFilter !== 'all' || chaseFilter !== 'all') {
        const meta = combatIndex.get(n.id.toLowerCase()) || combatIndex.get(n.code.toLowerCase());
        if (elementFilter !== 'all' && meta?.elementKey !== elementFilter) return false;
        if (chaseFilter !== 'all' && (!meta || !meta.chaseStates.has(chaseFilter))) return false;
      }

      if (
        q &&
        !n.id.toLowerCase().includes(q) &&
        !n.code.toLowerCase().includes(q) &&
        !(n.name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    if (sortBy === 'largest') {
      list.sort((a, b) => b.width * b.height - a.width * a.height);
    } else if (sortBy === 'smallest') {
      list.sort((a, b) => a.width * a.height - b.width * b.height);
    } else if (sortBy === 'name') {
      list.sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id, 'pt-BR', { numeric: true })
      );
    } else {
      list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }
    return list;
  }, [
    ninjas,
    kindFilter,
    onlyWithVideo,
    onlyPassiveAura,
    collectionFilter,
    favoriteSet,
    collections.exported,
    collections.assignments,
    elementFilter,
    chaseFilter,
    combatIndex,
    search,
    sortBy,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  const activeCollectionLabel = useMemo(() => {
    if (collectionFilter === 'favorites') return 'Favoritos';
    if (collectionFilter === 'exported') return 'Já exportados';
    if (collectionFilter === 'not_exported') return 'Falta exportar';
    if (collectionFilter.startsWith('tag:')) {
      const tid = collectionFilter.slice(4);
      return collections.tags.find((t) => t.id === tid)?.name || 'Lista';
    }
    return 'Filtrados';
  }, [collectionFilter, collections.tags]);

  const handlePageChange = (nextPage: number, scrollTop = false) => {
    onPageChange(nextPage);
    if (scrollTop && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const toggleChecked = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateTagSubmit = () => {
    const created = createCustomTag(newTagName);
    if (created) {
      setCollectionFilter(`tag:${created.id}`);
      onPageChange(1);
    }
    setNewTagName('');
    setCreatingTag(false);
  };

  const hasExtraFilters =
    collectionFilter !== 'all' ||
    elementFilter !== 'all' ||
    chaseFilter !== 'all' ||
    onlyPassiveAura;

  const resetAllFilters = () => {
    onSearchChange('');
    onOnlyWithVideoChange(false);
    onKindFilterChange('all');
    setCollectionFilter('all');
    setElementFilter('all');
    setChaseFilter('all');
    setOnlyPassiveAura(false);
    onPageChange(1);
  };

  const openBatchForChecked = () => {
    const picked = ninjas.filter((n) => checkedIds.has(n.id));
    if (picked.length === 0) return;
    setBatchModalLabel('Selecionados');
    setBatchModalNinjas(picked);
  };

  const openBatchForFiltered = () => {
    if (filtered.length === 0) return;
    setBatchModalLabel(activeCollectionLabel);
    setBatchModalNinjas(filtered);
  };

  if (isLoading && ninjas.length === 0) {
    return (
      <section className="space-y-5">
        <div className="flex items-center justify-between border-b border-white/[0.07] pb-4">
          <div className="space-y-2">
            <div className="h-6 w-36 animate-pulse rounded bg-white/[0.07]" />
            <div className="h-3.5 w-56 animate-pulse rounded bg-white/[0.05]" />
          </div>
          {headerExtra}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#11141C]"
            >
              <div className="h-40 animate-pulse bg-white/[0.03]" />
              <div className="space-y-2 p-3">
                <div className="h-3.5 w-24 animate-pulse rounded bg-white/[0.07]" />
                <div className="h-2.5 w-16 animate-pulse rounded bg-white/[0.04]" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (ninjas.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-white/[0.07] bg-[#11141C] p-8 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum personagem carregado
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Defina a fonte de dados ou abra um arquivo de backup local para explorar o catálogo.
        </p>
        <button
          type="button"
          onClick={onOpenSourceSettings}
          className="mt-5 inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
        >
          Configurar fonte
        </button>
      </div>
    );
  }

  return (
    <section ref={sectionRef} className="space-y-5">
      {/* Header Row */}
      <div className="flex flex-col gap-3.5 border-b border-white/[0.07] pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-50">
              Catálogo
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400 tabular-nums">
              <span>
                {filtered.length.toLocaleString('pt-BR')} de {ninjas.length.toLocaleString('pt-BR')} itens
              </span>
              {totalPages > 1 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Página {safePage} de {totalPages}
                  </span>
                </>
              )}
              {sourceLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-slate-500">{sourceLabel}</span>
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {headerExtra}
            <button
              type="button"
              onClick={() => {
                setSelectionMode((v) => {
                  if (v) setCheckedIds(new Set());
                  return !v;
                });
              }}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                selectionMode
                  ? 'border-orange-500/70 bg-orange-500/15 text-orange-200'
                  : 'border-white/[0.08] bg-[#11141C] text-slate-300 hover:border-white/20 hover:text-white'
              }`}
            >
              <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{selectionMode ? 'Sair da seleção' : 'Selecionar'}</span>
            </button>

            <button
              type="button"
              disabled={filtered.length === 0}
              onClick={openBatchForFiltered}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/50 hover:text-white disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap tabular-nums"
              title="Gerar 1 único script Termux para exportar os ninjas filtrados em sequência"
            >
              <Terminal className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
              <span>Lote Termux ({filtered.length})</span>
            </button>
          </div>
        </div>

        {/* Row 1: Category Tabs + Search + Sort */}
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex w-full sm:w-fit items-center gap-1 overflow-x-auto rounded-lg border border-white/[0.08] bg-[#11141C] p-1">
              {(
                [
                  { id: 'character', label: 'Ninjas', count: counts.character },
                  { id: 'summon_skin', label: 'Invocações', count: counts.summon_skin },
                  { id: 'effect', label: 'Efeitos', count: counts.effect },
                  { id: 'all', label: 'Todos', count: counts.all },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onKindFilterChange(tab.id)}
                  aria-pressed={kindFilter === tab.id}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                    kindFilter === tab.id
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {tab.label}{' '}
                  <span className={kindFilter === tab.id ? 'text-orange-100/90' : 'text-slate-500'}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[190px] sm:w-64 sm:flex-initial">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Buscar ninja ou ID..."
                aria-label="Buscar por nome ou ID"
                className="w-full rounded-lg border border-white/[0.08] bg-[#11141C] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>

            <select
              value={sortBy}
              onChange={(e) =>
                onSortByChange(e.target.value as 'id' | 'name' | 'largest' | 'smallest')
              }
              aria-label="Ordenar catálogo"
              className="rounded-lg border border-white/[0.08] bg-[#11141C] px-3 py-2 text-xs font-medium text-slate-200 focus:border-orange-500 focus:outline-none cursor-pointer"
            >
              <option value="id">Ordenar: ID</option>
              <option value="name">Ordenar: Nome</option>
              <option value="largest">Ordenar: Maior</option>
              <option value="smallest">Ordenar: Menor</option>
            </select>
          </div>
        </div>

        {/* Row 2: Collections / Favorites / Exported & Smart Combat Filters */}
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          {/* Interactive Collection Filter Strip */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all' as CollectionFilter, label: 'Todas listas' },
                {
                  id: 'favorites' as CollectionFilter,
                  label: `Favoritos (${counts.favorites})`,
                },
                {
                  id: 'exported' as CollectionFilter,
                  label: `Exportados (${counts.exported})`,
                },
                {
                  id: 'not_exported' as CollectionFilter,
                  label: 'Falta exportar',
                },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => {
                  setCollectionFilter(btn.id);
                  onPageChange(1);
                }}
                aria-pressed={collectionFilter === btn.id}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                  collectionFilter === btn.id
                    ? 'border-orange-500/60 bg-orange-500/15 text-orange-200'
                    : 'border-white/[0.07] bg-[#0E1118] text-slate-400 hover:border-white/20 hover:text-slate-200'
                }`}
              >
                {btn.label}
              </button>
            ))}

            {collections.tags.map((tag) => {
              const filterId: CollectionFilter = `tag:${tag.id}`;
              const tagCount = Object.values(collections.assignments).filter((list) =>
                list.includes(tag.id)
              ).length;
              const active = collectionFilter === filterId;
              return (
                <div key={tag.id} className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setCollectionFilter(active ? 'all' : filterId);
                      onPageChange(1);
                    }}
                    aria-pressed={active}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                      active
                        ? 'border-orange-500/60 bg-orange-500/15 text-orange-200'
                        : 'border-white/[0.07] bg-[#0E1118] text-slate-400 hover:border-white/20 hover:text-slate-200'
                    }`}
                  >
                    {tag.name} {tagCount > 0 ? `(${tagCount})` : ''}
                  </button>
                  {!tag.builtIn && (
                    <button
                      type="button"
                      onClick={() => {
                        if (active) setCollectionFilter('all');
                        deleteCustomTag(tag.id);
                      }}
                      aria-label={`Excluir lista ${tag.name}`}
                      className="ml-0.5 rounded p-1 text-slate-500 hover:text-rose-400 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}

            {creatingTag ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreateTagSubmit();
                }}
                className="inline-flex items-center gap-1"
              >
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Nome da lista..."
                  autoFocus
                  maxLength={28}
                  className="w-32 rounded-lg border border-orange-500/50 bg-[#0C0F16] px-2.5 py-1 text-xs text-slate-100 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-orange-600 px-2 py-1 text-xs font-medium text-white hover:bg-orange-500 cursor-pointer"
                >
                  Criar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreatingTag(false);
                    setNewTagName('');
                  }}
                  className="rounded-lg px-1.5 py-1 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingTag(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-white/15 px-2.5 py-1.5 text-xs text-slate-400 hover:border-white/30 hover:text-slate-200 cursor-pointer whitespace-nowrap"
              >
                <Plus className="h-3 w-3" />
                <span>Nova lista</span>
              </button>
            )}
          </div>

          {/* Smart Combat Filters (Element, Chase, Aura, Video) */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={elementFilter}
              onChange={(e) => {
                setElementFilter(e.target.value as ElementFilter);
                onPageChange(1);
              }}
              aria-label="Filtrar por elemento"
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium focus:border-orange-500 focus:outline-none cursor-pointer ${
                elementFilter !== 'all'
                  ? 'border-orange-500/60 bg-orange-500/15 text-orange-200'
                  : 'border-white/[0.08] bg-[#11141C] text-slate-300'
              }`}
            >
              {ELEMENT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>

            <select
              value={chaseFilter}
              onChange={(e) => {
                setChaseFilter(e.target.value as ChaseFilter);
                onPageChange(1);
              }}
              aria-label="Filtrar por tipo de perseguição"
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium focus:border-orange-500 focus:outline-none cursor-pointer ${
                chaseFilter !== 'all'
                  ? 'border-orange-500/60 bg-orange-500/15 text-orange-200'
                  : 'border-white/[0.08] bg-[#11141C] text-slate-300'
              }`}
            >
              {CHASE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>

            {counts.withAura > 0 && (
              <button
                type="button"
                onClick={() => {
                  setOnlyPassiveAura((v) => !v);
                  onPageChange(1);
                }}
                aria-pressed={onlyPassiveAura}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                  onlyPassiveAura
                    ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                    : 'border-white/[0.08] bg-[#11141C] text-slate-300 hover:border-white/20'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Com aura ({counts.withAura})</span>
              </button>
            )}

            {counts.withVideo > 0 && (
              <button
                type="button"
                onClick={() => onOnlyWithVideoChange(!onlyWithVideo)}
                aria-pressed={onlyWithVideo}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                  onlyWithVideo
                    ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                    : 'border-white/[0.08] bg-[#11141C] text-slate-300 hover:border-white/20'
                }`}
              >
                <Clapperboard className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Com vídeo ({counts.withVideo})</span>
              </button>
            )}
          </div>
        </div>

        {/* Batch Selection Action Bar */}
        {selectionMode && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/35 bg-orange-500/[0.07] px-3.5 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2 tabular-nums">
              <span className="font-semibold text-orange-200">
                {checkedIds.size} selecionado(s)
              </span>
              <span className="text-slate-500" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                onClick={() => {
                  setCheckedIds((prev) => {
                    const next = new Set(prev);
                    for (const item of pageItems) next.add(item.id);
                    return next;
                  });
                }}
                className="text-slate-300 underline-offset-2 hover:text-white hover:underline cursor-pointer"
              >
                Marcar página ({pageItems.length})
              </button>
              <button
                type="button"
                onClick={() => setCheckedIds(new Set(filtered.map((n) => n.id)))}
                className="text-slate-300 underline-offset-2 hover:text-white hover:underline cursor-pointer"
              >
                Marcar filtrados ({filtered.length})
              </button>
              {checkedIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => setCheckedIds(new Set())}
                  className="text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Limpar
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {checkedIds.size > 0 && (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const tid = e.target.value;
                    if (!tid) return;
                    setBulkNinjaTag(Array.from(checkedIds), tid, true);
                    e.target.value = '';
                  }}
                  aria-label="Adicionar selecionados a uma lista"
                  className="rounded-lg border border-white/15 bg-[#0C0F16] px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer"
                >
                  <option value="">+ Adicionar à lista...</option>
                  {collections.tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                disabled={checkedIds.size === 0}
                onClick={openBatchForChecked}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 cursor-pointer"
              >
                <Terminal className="h-3.5 w-3.5" />
                <span>Exportar via Termux ({checkedIds.size})</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Grid */}
      {pageItems.length === 0 ? (
        <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center space-y-3">
          <p className="text-sm text-slate-400">
            Nenhum personagem corresponde aos filtros ativos{search ? ` para "${search}"` : ''}.
          </p>
          {(search || onlyWithVideo || kindFilter !== 'all' || hasExtraFilters) && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="rounded-lg border border-white/10 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer"
            >
              Limpar todos os filtros
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {pageItems.map((ninja) => {
            const combatMeta =
              combatIndex.get(ninja.id.toLowerCase()) || combatIndex.get(ninja.code.toLowerCase());
            const coverage = offlineZip.active ? getNinjaOfflineCoverage(ninja) : null;
            return (
              <NinjaCard
                key={`${offlineZip.generation}:${ninja.id}`}
                ninja={ninja}
                isSelected={ninja.id === selectedNinjaId}
                isFavorite={favoriteSet.has(ninja.id)}
                isExported={Boolean(collections.exported[ninja.id])}
                selectionMode={selectionMode}
                isChecked={checkedIds.has(ninja.id)}
                elementLabel={combatMeta?.elementLabel || null}
                coverage={coverage}
                autoThumbnails={autoThumbnails}
                offlineGen={offlineZip.generation}
                onSelect={() => onSelectNinja(ninja)}
                onToggleFavorite={() => toggleNinjaFavorite(ninja.id)}
                onToggleChecked={() => toggleChecked(ninja.id)}
              />
            );
          })}
        </div>
      )}

      {/* Bottom Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-4">
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            Página {safePage} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => handlePageChange(Math.max(1, safePage - 1), true)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Anterior</span>
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => handlePageChange(Math.min(totalPages, safePage + 1), true)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <span>Próxima</span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Batch Termux Export Modal */}
      <TermuxBatchExportModal
        open={Boolean(batchModalNinjas && batchModalNinjas.length > 0)}
        ninjas={batchModalNinjas || []}
        sourceLabel={batchModalLabel}
        onClose={() => setBatchModalNinjas(null)}
      />
    </section>
  );
}
