import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  Image as ImageIcon,
  Search,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import { extractRegionToCanvas, loadImageElement, parseAtlas } from '../utils/atlasParser';
import {
  fetchNinjaBundle,
  getNinjaThumbUrl,
  resolveAssetFetchUrl,
  resolveStaticNinjaThumbUrl,
} from '../utils/remoteClient';
import { useOfflineZipState } from '../utils/offlineZipStore';

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
  onOpenBatchZip: (list: NinjaEntry[]) => void;
  headerExtra?: ReactNode;
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
  autoThumbnails,
  offlineGen,
  onSelect,
}: {
  ninja: NinjaEntry;
  isSelected: boolean;
  autoThumbnails: boolean;
  offlineGen: number;
  onSelect: () => void;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
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
    <button
      ref={cardRef}
      type="button"
      onClick={onSelect}
      className={`group flex flex-col overflow-hidden rounded-xl border text-left transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
        isSelected
          ? 'border-orange-500/80 bg-[#151A25]'
          : 'border-white/[0.07] bg-[#11141C] hover:border-white/20'
      }`}
    >
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
          <span className="shrink-0">{KIND_LABELS[kind]}</span>
          {ninja.hasVideo && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 text-cyan-400">Vídeo</span>
            </>
          )}
        </div>
      </div>
    </button>
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
  onOpenBatchZip,
  headerExtra,
}: NinjaCatalogProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const offlineZip = useOfflineZipState();
  if (lastThumbOfflineGeneration !== offlineZip.generation) {
    lastThumbOfflineGeneration = offlineZip.generation;
    thumbnailCache.clear();
    inFlightRequests.clear();
  }

  const counts = useMemo(() => {
    let character = 0;
    let summon_skin = 0;
    let effect = 0;
    let withVideo = 0;
    for (const n of ninjas) {
      const k = getSpineKind(n);
      if (k === 'character') character++;
      else if (k === 'summon_skin') summon_skin++;
      else effect++;
      if (n.hasVideo) withVideo++;
    }
    return { all: ninjas.length, character, summon_skin, effect, withVideo };
  }, [ninjas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = ninjas.filter((n) => {
      if (kindFilter !== 'all' && getSpineKind(n) !== kindFilter) return false;
      if (onlyWithVideo && !n.hasVideo) return false;
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
  }, [ninjas, kindFilter, onlyWithVideo, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  const isFilteredSubset = filtered.length > 0 && filtered.length < ninjas.length;

  const handlePageChange = (nextPage: number, scrollTop = false) => {
    onPageChange(nextPage);
    if (scrollTop && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
      <div className="flex flex-col gap-4 border-b border-white/[0.07] pb-4">
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
            {isFilteredSubset && (
              <button
                type="button"
                onClick={() => onOpenBatchZip(filtered)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#11141C] px-3 py-2 text-xs font-medium text-slate-200 hover:border-orange-500/60 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Exportar filtrados ({filtered.length})</span>
              </button>
            )}
            {headerExtra}
          </div>
        </div>

        {/* Unified Filter & Search Toolbar */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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

            {counts.withVideo > 0 && (
              <button
                type="button"
                onClick={() => onOnlyWithVideoChange(!onlyWithVideo)}
                aria-pressed={onlyWithVideo}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  onlyWithVideo
                    ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                    : 'border-white/[0.08] bg-[#11141C] text-slate-300 hover:border-white/20 hover:text-slate-100'
                }`}
              >
                <Clapperboard className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Com vídeo ({counts.withVideo})</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] sm:w-64 sm:flex-initial">
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
      </div>

      {/* Grid */}
      {pageItems.length === 0 ? (
        <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center space-y-3">
          <p className="text-sm text-slate-400">
            Nenhum item encontrado para "{search}".
          </p>
          {(search || onlyWithVideo || kindFilter !== 'all') && (
            <button
              type="button"
              onClick={() => {
                onSearchChange('');
                onOnlyWithVideoChange(false);
                onKindFilterChange('all');
              }}
              className="rounded-lg border border-white/10 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer"
            >
              Limpar filtros
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {pageItems.map((ninja) => (
            <NinjaCard
              key={`${offlineZip.generation}:${ninja.id}`}
              ninja={ninja}
              isSelected={ninja.id === selectedNinjaId}
              autoThumbnails={autoThumbnails}
              offlineGen={offlineZip.generation}
              onSelect={() => onSelectNinja(ninja)}
            />
          ))}
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
    </section>
  );
}
