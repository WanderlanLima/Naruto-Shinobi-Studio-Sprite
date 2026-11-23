import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, Globe, HardDrive, SlidersHorizontal, WifiOff, X } from 'lucide-react';
import { BatchZipModal } from './components/BatchZipModal';
import { GeneralAssetsView } from './components/GeneralAssetsView';
import { LocalSlicer } from './components/LocalSlicer';
import { NinjaCatalog } from './components/NinjaCatalog';
import { OfflineBackupView } from './components/OfflineBackupView';
import { OfflineIndicator, PWAInstallAction } from './components/PWAInstallBanner';
import { StudioStage } from './components/StudioStage';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import {
  initPersistedOfflineSource,
  mountBackupZipFiles,
  pickAndMountOfflineZipFiles,
  reauthorizeSavedOfflineHandles,
  setPreferredSourceMode,
  useOfflineZipState,
} from './utils/offlineZipStore';
import type {
  ExtractResponse,
  NinjaEntry,
  SlicedFrame,
  SpineSkeleton,
} from './types/sprite';
import { exportFramesAsZip } from './utils/atlasParser';
import {
  clearMediaProfileCache,
  extractGameCatalog,
  getSavedCorsProxy,
  setSavedCorsProxy,
} from './utils/remoteClient';

const DEFAULT_GAME_URL = 'https://naruto.jotagame.com/';
const SAVED_GAME_URL_KEY = 'shinobi_saved_game_url_v1';
const CATALOG_STATE_STORAGE_KEY = 'shinobi_catalog_state_v1';

function loadSavedGameUrl(): string {
  try {
    const raw = localStorage.getItem(SAVED_GAME_URL_KEY);
    if (raw && /^https?:\/\//i.test(raw.trim())) {
      return raw.trim();
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_GAME_URL;
}

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface SavedCatalogState {
  search: string;
  kindFilter: 'character' | 'summon_skin' | 'effect' | 'all';
  onlyWithVideo: boolean;
  sortBy: 'id' | 'name' | 'largest' | 'smallest';
  page: number;
}

function loadSavedCatalogState(): SavedCatalogState {
  try {
    const raw = sessionStorage.getItem(CATALOG_STATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SavedCatalogState>;
      const validKinds = ['character', 'summon_skin', 'effect', 'all'] as const;
      const validSorts = ['id', 'name', 'largest', 'smallest'] as const;
      return {
        search: typeof parsed.search === 'string' ? parsed.search : '',
        kindFilter: validKinds.includes(parsed.kindFilter as (typeof validKinds)[number])
          ? (parsed.kindFilter as SavedCatalogState['kindFilter'])
          : 'character',
        onlyWithVideo: Boolean(parsed.onlyWithVideo),
        sortBy: validSorts.includes(parsed.sortBy as (typeof validSorts)[number])
          ? (parsed.sortBy as SavedCatalogState['sortBy'])
          : 'id',
        page:
          typeof parsed.page === 'number' && Number.isFinite(parsed.page) && parsed.page >= 1
            ? Math.floor(parsed.page)
            : 1,
      };
    }
  } catch {
    // ignore storage errors
  }
  return { search: '', kindFilter: 'character', onlyWithVideo: false, sortBy: 'id', page: 1 };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('ninjas');
  const [targetUrl, setTargetUrl] = useState(() => loadSavedGameUrl());
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);
  const [quickMounting, setQuickMounting] = useState(false);
  const [quickMountError, setQuickMountError] = useState<string | null>(null);
  const quickOfflineInputRef = useRef<HTMLInputElement | null>(null);
  const offlineZip = useOfflineZipState();
  const activeCatalog = offlineZip.active && offlineZip.catalog ? offlineZip.catalog : extractResult;

  const [selectedNinja, setSelectedNinja] = useState<NinjaEntry | null>(null);
  const [studioExportPayload, setStudioExportPayload] = useState<{
    ninjaId: string;
    frames: SlicedFrame[];
    atlasText: string;
    skeleton: SpineSkeleton | null;
  } | null>(null);

  const [localSlicerSource, setLocalSlicerSource] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const [localExportPayload, setLocalExportPayload] = useState<{
    name: string;
    frames: SlicedFrame[];
  } | null>(null);

  const [isExportingZip, setIsExportingZip] = useState(false);
  const [batchZipList, setBatchZipList] = useState<NinjaEntry[] | null>(null);
  const [studioCompleteExportSignal, setStudioCompleteExportSignal] = useState(0);

  const [showSourcePanel, setShowSourcePanel] = useState(false);
  const [corsProxyInput, setCorsProxyInput] = useState(() => getSavedCorsProxy());
  const [proxySavedNotice, setProxySavedNotice] = useState(false);

  const initialCatalog = useRef<SavedCatalogState | null>(null);
  if (!initialCatalog.current) {
    initialCatalog.current = loadSavedCatalogState();
  }
  const [catalogSearch, setCatalogSearch] = useState(initialCatalog.current.search);
  const [catalogKindFilter, setCatalogKindFilter] = useState<
    'character' | 'summon_skin' | 'effect' | 'all'
  >(initialCatalog.current.kindFilter);
  const [catalogOnlyWithVideo, setCatalogOnlyWithVideo] = useState(
    initialCatalog.current.onlyWithVideo
  );
  const [catalogSortBy, setCatalogSortBy] = useState<'id' | 'name' | 'largest' | 'smallest'>(
    initialCatalog.current.sortBy
  );
  const [catalogAutoThumbnails, setCatalogAutoThumbnails] = useState(true);
  const [catalogPage, setCatalogPage] = useState(initialCatalog.current.page);

  const catalogReturnScrollYRef = useRef<number | null>(null);
  const pushedStudioHistoryRef = useRef(false);

  useEffect(() => {
    try {
      const payload: SavedCatalogState = {
        search: catalogSearch,
        kindFilter: catalogKindFilter,
        onlyWithVideo: catalogOnlyWithVideo,
        sortBy: catalogSortBy,
        page: catalogPage,
      };
      sessionStorage.setItem(CATALOG_STATE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  }, [catalogSearch, catalogKindFilter, catalogOnlyWithVideo, catalogSortBy, catalogPage]);

  const restoreCatalogScroll = useCallback(() => {
    const targetY = catalogReturnScrollYRef.current;
    if (targetY === null) return;
    catalogReturnScrollYRef.current = null;
    requestAnimationFrame(() => {
      window.scrollTo({ top: targetY, behavior: 'auto' });
      requestAnimationFrame(() => {
        window.scrollTo({ top: targetY, behavior: 'auto' });
      });
    });
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (pushedStudioHistoryRef.current) {
        pushedStudioHistoryRef.current = false;
        setActiveTab('ninjas');
        restoreCatalogScroll();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [restoreCatalogScroll]);

  const runExtraction = useCallback(async (urlToScan: string) => {
    const trimmed = urlToScan.trim();
    if (!trimmed) return;

    try {
      localStorage.setItem(SAVED_GAME_URL_KEY, trimmed);
    } catch {
      // ignore storage errors
    }

    setExtracting(true);
    setExtractError(null);
    try {
      const data = await extractGameCatalog(trimmed);
      setExtractResult(data);
      if (data.ninjas.length > 0) {
        setSelectedNinja((prev) => prev || data.ninjas[0]);
      }
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Falha ao carregar catálogo.');
    } finally {
      setExtracting(false);
    }
  }, []);

  useEffect(() => {
    void initPersistedOfflineSource();
    void runExtraction(loadSavedGameUrl());
  }, [runExtraction]);

  const handleQuickMountFromInput = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const validFiles: File[] = [];
    for (const f of Array.from(fileList)) {
      if (f.size < 22) continue;
      if (f.name.toLowerCase().endsWith('.zip') || f.type.includes('zip')) {
        validFiles.push(f);
        continue;
      }
      try {
        const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (head[0] === 0x50 && head[1] === 0x4b) {
          validFiles.push(f);
        }
      } catch {
        // ignore unreadable file
      }
    }
    if (validFiles.length === 0) {
      setQuickMountError('Selecione arquivos válidos no formato .zip.');
      return;
    }
    setQuickMounting(true);
    setQuickMountError(null);
    try {
      clearMediaProfileCache();
      await mountBackupZipFiles(validFiles, { append: false, activateOffline: true });
    } catch (err) {
      setQuickMountError(
        err instanceof Error ? err.message : 'Não foi possível abrir o arquivo offline.'
      );
    } finally {
      setQuickMounting(false);
      if (quickOfflineInputRef.current) quickOfflineInputRef.current.value = '';
    }
  };

  const handleActivateOfflineSource = async () => {
    setQuickMountError(null);
    if (offlineZip.hasMountedArchives) {
      clearMediaProfileCache();
      setPreferredSourceMode('offline');
      return;
    }
    if (offlineZip.canOneClickReauthorize) {
      setQuickMounting(true);
      try {
        clearMediaProfileCache();
        const ok = await reauthorizeSavedOfflineHandles();
        if (!ok) {
          setQuickMountError('Permissão necessária para reabrir o arquivo offline salvo.');
        }
      } finally {
        setQuickMounting(false);
      }
      return;
    }
    // Open native picker (File System Access API when supported -> saves persistent handle; otherwise <input>)
    setQuickMounting(true);
    try {
      const picked = await pickAndMountOfflineZipFiles({ append: false });
      if (picked.status === 'mounted') {
        clearMediaProfileCache();
      } else if (picked.status === 'fallback-input') {
        quickOfflineInputRef.current?.click();
      }
    } catch (err) {
      setQuickMountError(
        err instanceof Error ? err.message : 'Não foi possível abrir o arquivo offline.'
      );
    } finally {
      setQuickMounting(false);
    }
  };

  const handleSwitchToGameSite = () => {
    setQuickMountError(null);
    clearMediaProfileCache();
    setPreferredSourceMode('online');
    if (!extractResult && !extracting) {
      void runExtraction(targetUrl);
    }
  };

  useEffect(() => {
    if (!activeCatalog?.ninjas.length) return;
    setSelectedNinja((prev) => {
      if (prev && activeCatalog.ninjas.some((n) => n.id === prev.id)) {
        return prev;
      }
      return activeCatalog.ninjas[0];
    });
  }, [activeCatalog]);

  const handleSelectNinja = (ninja: NinjaEntry) => {
    catalogReturnScrollYRef.current = window.scrollY;
    try {
      window.history.pushState({ view: 'studio', ninjaId: ninja.id, catalogPage }, '');
      pushedStudioHistoryRef.current = true;
    } catch {
      // ignore history errors in sandboxed iframes
    }
    setSelectedNinja(ninja);
    setActiveTab('studio');
  };

  const handleBackToCatalog = useCallback(() => {
    if (pushedStudioHistoryRef.current) {
      pushedStudioHistoryRef.current = false;
      try {
        window.history.replaceState({ view: 'ninjas', catalogPage }, '');
      } catch {
        // ignore history errors
      }
    }
    setActiveTab('ninjas');
    restoreCatalogScroll();
  }, [catalogPage, restoreCatalogScroll]);

  const handleSendToSlicer = (proxyUrl: string, filename: string) => {
    setLocalSlicerSource({ url: proxyUrl, filename });
    setActiveTab('slicer');
  };

  const handleLoadedFramesChange = useCallback(
    (
      payload: {
        ninjaId: string;
        frames: SlicedFrame[];
        atlasText: string;
        skeleton: SpineSkeleton | null;
      } | null
    ) => {
      setStudioExportPayload(payload);
    },
    []
  );

  const handleLocalFramesChange = useCallback((frames: SlicedFrame[], name: string) => {
    setLocalExportPayload(frames.length > 0 ? { frames, name } : null);
  }, []);

  const hasSingleNinjaOrLocalZip =
    (activeTab === 'slicer' && Boolean(localExportPayload?.frames.length)) ||
    (activeTab === 'studio' && Boolean(studioExportPayload?.frames.length));

  const canExportZip =
    hasSingleNinjaOrLocalZip ||
    Boolean(activeCatalog?.ninjas.length) ||
    Boolean(studioExportPayload?.frames.length);

  const exportLabel =
    activeTab === 'studio'
      ? 'Exportar ninja'
      : activeTab === 'slicer'
      ? 'Exportar PNGs'
      : 'Exportar lote';

  const handleGlobalExportZip = async () => {
    if (activeTab === 'slicer' && localExportPayload?.frames.length) {
      setIsExportingZip(true);
      try {
        await exportFramesAsZip(
          `${localExportPayload.name}_sprites.zip`,
          localExportPayload.frames
        );
      } finally {
        setIsExportingZip(false);
      }
      return;
    }

    if (activeTab === 'studio' && studioExportPayload?.frames.length) {
      setStudioCompleteExportSignal((v) => v + 1);
      return;
    }

    if (activeCatalog?.ninjas.length) {
      setBatchZipList(activeCatalog.ninjas);
    }
  };

  const handleSaveProxy = () => {
    setSavedCorsProxy(corsProxyInput);
    setProxySavedNotice(true);
    setTimeout(() => setProxySavedNotice(false), 2000);
  };

  const sourceLabel = offlineZip.active
    ? `Backup local (${offlineZip.archives.length} ${offlineZip.archives.length === 1 ? 'arquivo' : 'arquivos'})`
    : activeCatalog?.resolvedGameUrl
    ? activeCatalog.resolvedGameUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    : targetUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');

  const savedSummaryLabel =
    offlineZip.savedArchives.length > 0
      ? offlineZip.savedArchives.length === 1
        ? `${offlineZip.savedArchives[0].fileName} (${formatCompactBytes(offlineZip.savedArchives[0].fileSize)})`
        : `${offlineZip.savedArchives.length} arquivos salvos (${formatCompactBytes(
            offlineZip.savedArchives.reduce((sum, a) => sum + a.fileSize, 0)
          )})`
      : 'Backup offline salvo';

  return (
    <div className="min-h-screen flex flex-col bg-[#090B10] text-slate-100">
      <input
        ref={quickOfflineInputRef}
        type="file"
        multiple
        onChange={(e) => void handleQuickMountFromInput(e.target.files)}
        className="hidden"
      />

      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        canExportZip={canExportZip}
        isExportingZip={isExportingZip}
        exportLabel={exportLabel}
        onExportZip={() => void handleGlobalExportZip()}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-5 sm:px-6 sm:py-6">
        {activeTab === 'ninjas' && (
          <div className="space-y-5">
            {offlineZip.active && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/25 bg-emerald-950/20 px-4 py-2.5 text-xs text-emerald-200">
                <div className="flex items-center gap-2 min-w-0">
                  <WifiOff className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    Modo offline ativo · {offlineZip.archives.length}{' '}
                    {offlineZip.archives.length === 1 ? 'arquivo carregado' : 'arquivos carregados'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={handleSwitchToGameSite}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-[#090B10]/80 px-2.5 py-1 font-medium text-slate-200 hover:border-orange-400/50 hover:text-orange-200 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Globe className="h-3 w-3" aria-hidden="true" />
                    <span>Voltar ao site do jogo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('backup')}
                    className="font-medium text-emerald-300 hover:text-emerald-100 underline-offset-4 hover:underline cursor-pointer whitespace-nowrap"
                  >
                    Gerenciar backup
                  </button>
                </div>
              </div>
            )}

            {offlineZip.needsReconnect && !offlineZip.restoring && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-2.5 text-xs text-amber-100">
                <div className="flex items-center gap-2 min-w-0">
                  <HardDrive className="h-3.5 w-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    Preferência salva em modo offline ·{' '}
                    <span className="font-mono text-amber-200">{savedSummaryLabel}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={quickMounting}
                    onClick={() => void handleActivateOfflineSource()}
                    className="rounded-md bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {quickMounting
                      ? 'Conectando...'
                      : offlineZip.canOneClickReauthorize
                      ? 'Reativar offline (1 clique)'
                      : 'Reconectar .ZIP offline'}
                  </button>
                  <button
                    type="button"
                    onClick={handleSwitchToGameSite}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-[#090B10]/80 px-3 py-1.5 font-medium text-slate-200 hover:border-white/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Globe className="h-3 w-3" aria-hidden="true" />
                    <span>Usar site do jogo</span>
                  </button>
                </div>
              </div>
            )}

            {quickMountError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/25 px-4 py-2.5 text-xs text-red-200"
              >
                <span>{quickMountError}</span>
                <button
                  type="button"
                  onClick={() => setQuickMountError(null)}
                  className="text-red-300 hover:text-white cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            {extractError && !offlineZip.active && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/25 px-4 py-3 text-xs text-red-200"
              >
                <span>{extractError}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runExtraction(targetUrl)}
                    className="rounded-md border border-red-400/40 px-3 py-1.5 font-medium text-red-100 hover:bg-red-900/40 cursor-pointer whitespace-nowrap"
                  >
                    Tentar novamente
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('backup')}
                    className="rounded-md bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-500 cursor-pointer whitespace-nowrap"
                  >
                    Abrir backup local
                  </button>
                </div>
              </div>
            )}

            {showSourcePanel && (
              <section className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-sm font-semibold text-slate-100">
                    Fonte de dados e opções
                  </h2>
                  <button
                    type="button"
                    onClick={() => setShowSourcePanel(false)}
                    aria-label="Fechar configurações de fonte"
                    className="rounded-md p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 cursor-pointer"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      clearMediaProfileCache();
                      setPreferredSourceMode('online');
                      void runExtraction(targetUrl);
                    }}
                    className="space-y-2"
                  >
                    <label className="block text-xs font-medium text-slate-300">
                      Endereço do jogo
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <div className="relative flex-1">
                        <Globe
                          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                          aria-hidden="true"
                        />
                        <input
                          type="url"
                          required
                          value={targetUrl}
                          onChange={(e) => setTargetUrl(e.target.value)}
                          placeholder="https://naruto.jotagame.com/"
                          aria-label="URL do jogo web"
                          className="w-full rounded-lg border border-white/10 bg-[#090B10] py-2 pl-9 pr-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={extracting}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <span>{extracting ? 'Carregando...' : 'Atualizar'}</span>
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </form>

                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-slate-300">
                      Proxy opcional (para outras URLs)
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="url"
                        value={corsProxyInput}
                        onChange={(e) => setCorsProxyInput(e.target.value)}
                        placeholder="Automático"
                        aria-label="URL de Proxy CORS"
                        className="w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleSaveProxy}
                        className="rounded-lg border border-white/10 bg-[#090B10] px-4 py-2 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer shrink-0 whitespace-nowrap"
                      >
                        {proxySavedNotice ? 'Salvo' : 'Salvar'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3 text-xs">
                  <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={catalogAutoThumbnails}
                      onChange={(e) => setCatalogAutoThumbnails(e.target.checked)}
                      className="h-3.5 w-3.5 accent-orange-500"
                    />
                    <span>Carregar miniaturas automaticamente</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSourcePanel(false);
                      setActiveTab('backup');
                    }}
                    className="inline-flex items-center gap-1.5 text-slate-300 hover:text-orange-400 transition-colors cursor-pointer"
                  >
                    <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Usar backup offline (.ZIP)</span>
                  </button>
                </div>
              </section>
            )}

            <NinjaCatalog
              ninjas={activeCatalog?.ninjas || []}
              isLoading={extracting && !activeCatalog}
              sourceLabel={sourceLabel}
              selectedNinjaId={selectedNinja?.id || null}
              search={catalogSearch}
              onSearchChange={(q) => {
                setCatalogSearch(q);
                setCatalogPage(1);
              }}
              kindFilter={catalogKindFilter}
              onKindFilterChange={(k) => {
                setCatalogKindFilter(k);
                setCatalogPage(1);
              }}
              onlyWithVideo={catalogOnlyWithVideo}
              onOnlyWithVideoChange={(v) => {
                setCatalogOnlyWithVideo(v);
                setCatalogPage(1);
              }}
              sortBy={catalogSortBy}
              onSortByChange={(s) => {
                setCatalogSortBy(s);
                setCatalogPage(1);
              }}
              autoThumbnails={catalogAutoThumbnails}
              page={catalogPage}
              onPageChange={setCatalogPage}
              onSelectNinja={handleSelectNinja}
              onOpenSourceSettings={() => setShowSourcePanel((v) => !v)}
              sourceSettingsOpen={showSourcePanel}
              onOpenBatchZip={(list) => setBatchZipList(list)}
              headerExtra={
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <div
                    role="group"
                    aria-label="Alternar fonte de dados"
                    className="inline-flex items-center rounded-lg border border-white/10 bg-[#090B10] p-0.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={handleSwitchToGameSite}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        !offlineZip.active
                          ? 'bg-orange-600 text-white'
                          : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      <Globe className="h-3 w-3" aria-hidden="true" />
                      <span>Site do jogo</span>
                    </button>
                    <button
                      type="button"
                      disabled={quickMounting}
                      onClick={() => void handleActivateOfflineSource()}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        offlineZip.active
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      <HardDrive className="h-3 w-3" aria-hidden="true" />
                      <span>
                        {quickMounting
                          ? 'Abrindo...'
                          : offlineZip.hasMountedArchives
                          ? 'Arquivo offline'
                          : 'Offline'}
                      </span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowSourcePanel((v) => !v)}
                    aria-expanded={showSourcePanel}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      showSourcePanel
                        ? 'border-orange-500/60 bg-orange-500/10 text-orange-300'
                        : 'border-white/10 bg-[#11141C] text-slate-300 hover:border-white/25 hover:text-slate-100'
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Fonte</span>
                  </button>
                </div>
              }
            />
          </div>
        )}

        {activeTab === 'studio' && (
          <StudioStage
            ninja={selectedNinja}
            openCompleteExportSignal={studioCompleteExportSignal}
            onBackToCatalog={handleBackToCatalog}
            onLoadedFramesChange={handleLoadedFramesChange}
          />
        )}

        {activeTab === 'assets' && (
          <GeneralAssetsView
            sheets={activeCatalog?.sheets || []}
            assets={activeCatalog?.assets || []}
            onSendToSlicer={handleSendToSlicer}
          />
        )}

        {activeTab === 'slicer' && (
          <LocalSlicer
            externalSource={localSlicerSource}
            onFramesChange={handleLocalFramesChange}
          />
        )}

        {activeTab === 'backup' && (
          <OfflineBackupView
            sourceUrl={targetUrl}
            ninjas={activeCatalog?.ninjas || []}
            onGoToCatalog={() => setActiveTab('ninjas')}
          />
        )}
      </main>

      <BatchZipModal
        isOpen={Boolean(batchZipList)}
        ninjas={batchZipList || []}
        onClose={() => setBatchZipList(null)}
      />

      <OfflineIndicator />

      <footer className="border-t border-white/[0.06] bg-[#090B10] py-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 sm:px-6 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-3">
            <span>Shinobi Studio</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-slate-400">{sourceLabel}</span>
          </div>
          <PWAInstallAction />
        </div>
      </footer>
    </div>
  );
}
