import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Copy,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Layers,
  Music,
  PackageCheck,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import {
  CLOUDFLARE_WORKER_PROXY_CODE,
  downloadDirectUnixScript,
  downloadDirectUrlList,
  downloadDirectWindowsScript,
  testCorsProxyForMedia,
} from '../utils/directBackupScript';
import {
  mountBackupZipFiles,
  setStrictOfflineMode,
  unmountBackupZip,
  useOfflineZipState,
} from '../utils/offlineZipStore';
import {
  clearMediaProfileCache,
  fetchStaticCatalogJson,
  getSavedCorsProxy,
  isStaticHostingMode,
  markStaticHostingMode,
  setSavedCorsProxy,
} from '../utils/remoteClient';
import {
  assembleAndSaveBackupJobZip,
  clearAllResumableBackupJobs,
  formatEta,
  getLatestSavedBackupJob,
  loadStaticBackupPlanBundle,
  resolveStandaloneNinjasFileList,
  saveBackupJobRecord,
  startOrResumeBackupDownload,
  type BackupModulePlanItem,
  type BackupPlanResponse,
  type BackupRunController,
  type ResumableBackupJob,
  type StaticBackupPlanBundle,
} from '../utils/resumableBackupEngine';

interface OfflineBackupViewProps {
  sourceUrl: string;
  ninjas: NinjaEntry[];
  onGoToCatalog: () => void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return 'Calculando...';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

function triggerNativeDownload(downloadUrl: string, filename?: string) {
  if (!downloadUrl.startsWith('/api/backup/')) return;
  const a = document.createElement('a');
  a.href = downloadUrl;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
  }, 1500);
}

export function OfflineBackupView({
  sourceUrl,
  ninjas,
  onGoToCatalog,
}: OfflineBackupViewProps) {
  const offlineZip = useOfflineZipState();
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const appendInputRef = useRef<HTMLInputElement | null>(null);
  const runControllerRef = useRef<BackupRunController | null>(null);
  const autoResumingRef = useRef(false);

  const [mounting, setMounting] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Backup plan state (works in both Node server & GitHub Pages static mode)
  const [plan, setPlan] = useState<BackupPlanResponse | null>(null);
  const [staticBundle, setStaticBundle] = useState<StaticBackupPlanBundle | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(() => new Set());
  const [downloadTab, setDownloadTab] = useState<'modular' | 'presets' | 'custom'>('modular');

  // Resumable high-speed download state (IndexedDB-backed)
  const [activeJob, setActiveJob] = useState<ResumableBackupJob | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [currentFile, setCurrentFile] = useState('');
  const [assemblePercent, setAssemblePercent] = useState(0);
  const [manualSaving, setManualSaving] = useState(false);

  // Optional custom CORS proxy for full-speed in-browser MP4/MP3 ZIPs on GitHub Pages
  const [corsProxyInput, setCorsProxyInput] = useState(() => getSavedCorsProxy());
  const [corsProxySaved, setCorsProxySaved] = useState(() => Boolean(getSavedCorsProxy()));
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const [showWorkerGuide, setShowWorkerGuide] = useState(false);
  const [copiedWorkerCode, setCopiedWorkerCode] = useState(false);
  const workerPanelRef = useRef<HTMLDivElement | null>(null);

  // Custom ninja selection backup state
  const [customSearch, setCustomSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [customIncludeParticles, setCustomIncludeParticles] = useState(true);
  const [customIncludeVideos, setCustomIncludeVideos] = useState(true);
  const [customIncludeAudio, setCustomIncludeAudio] = useState(true);
  const [customIncludeNameArt, setCustomIncludeNameArt] = useState(true);
  const [preparingCustom, setPreparingCustom] = useState(false);
  const [customStatus, setCustomStatus] = useState<string | null>(null);

  const isJobRunning = activeJob?.status === 'running' || activeJob?.status === 'assembling';
  const staticMode = isStaticHostingMode() || plan?.planSource === 'static';

  const ensureStaticBundle = useCallback(async (): Promise<StaticBackupPlanBundle> => {
    if (staticBundle) return staticBundle;
    const loaded = await loadStaticBackupPlanBundle(ninjas, sourceUrl);
    setStaticBundle(loaded);
    return loaded;
  }, [staticBundle, ninjas, sourceUrl]);

  const fetchBackupPlan = useCallback(async () => {
    setLoadingPlan(true);
    setPlanError(null);
    try {
      // Try server API when Node backend is active
      if (!isStaticHostingMode()) {
        try {
          const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
          const resp = await fetch(`/api/backup/plan?url=${encodeURIComponent(target)}`);
          const contentType = resp.headers.get('content-type') || '';
          if (resp.ok && contentType.includes('application/json')) {
            const data = (await resp.json()) as BackupPlanResponse;
            setPlan({ ...data, planSource: 'server' });
            // Also pre-load static manifest in background so resumable client downloads are ready instantly
            void loadStaticBackupPlanBundle(ninjas, sourceUrl)
              .then((b) => setStaticBundle(b))
              .catch(() => {});
            return;
          }
          markStaticHostingMode();
        } catch {
          markStaticHostingMode();
          // Fall through seamlessly to static backup manifest
        }
      }

      // Static / GitHub Pages mode: load exact backup manifest from public/data/backup-manifest.zip
      const bundle = await loadStaticBackupPlanBundle(ninjas, sourceUrl);
      setStaticBundle(bundle);
      setPlan(bundle.plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao carregar plano de backup.');
    } finally {
      setLoadingPlan(false);
    }
  }, [ninjas, sourceUrl]);

  useEffect(() => {
    void fetchBackupPlan();
  }, [fetchBackupPlan]);

  // Restore any interrupted/paused resumable download from IndexedDB on mount
  useEffect(() => {
    let cancelled = false;
    void getLatestSavedBackupJob().then((saved) => {
      if (!cancelled && saved) {
        setActiveJob(saved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Abort active workers cleanly on unmount (progress remains checkpointed in IndexedDB)
  useEffect(() => {
    return () => {
      runControllerRef.current?.pause();
    };
  }, []);

  const launchJobExecution = useCallback(
    (
      jobOrSpec:
        | { mode: 'resume'; job: ResumableBackupJob; retryFailedOnly?: boolean }
        | {
            mode: 'new';
            spec: {
              moduleId: string;
              label: string;
              filename: string;
              origin: string;
              files: Array<{ path: string; size: number }>;
              includeCatalogMeta: boolean;
              customNinjaIds?: string[];
            };
          }
    ) => {
      runControllerRef.current?.pause();
      setSpeedBytesPerSec(0);
      setEtaSeconds(null);
      setAssemblePercent(0);
      setCurrentFile('');

      const ctrl = startOrResumeBackupDownload({
        existingJob: jobOrSpec.mode === 'resume' ? jobOrSpec.job : undefined,
        retryFailedOnly: jobOrSpec.mode === 'resume' ? jobOrSpec.retryFailedOnly : false,
        newJobSpec: jobOrSpec.mode === 'new' ? jobOrSpec.spec : undefined,
        ninjasForCatalog: ninjas,
        onProgress: (upd) => {
          setActiveJob(upd.job);
          setSpeedBytesPerSec(upd.speedBytesPerSec);
          setEtaSeconds(upd.etaSeconds);
          setCurrentFile(upd.currentFile);
          setAssemblePercent(upd.assemblePercent);
        },
        onComplete: (completed) => {
          runControllerRef.current = null;
          setActiveJob(completed);
          setSpeedBytesPerSec(0);
          setEtaSeconds(0);
          setAssemblePercent(100);
          setDownloadedIds((prev) => new Set(prev).add(completed.moduleId));
        },
        onPaused: (pausedJob) => {
          runControllerRef.current = null;
          setActiveJob(pausedJob);
          setSpeedBytesPerSec(0);
          setEtaSeconds(null);
        },
        onError: (errJob) => {
          runControllerRef.current = null;
          setActiveJob(errJob);
          setSpeedBytesPerSec(0);
          setEtaSeconds(null);
        },
      });
      runControllerRef.current = ctrl;
    },
    [ninjas]
  );

  // Auto-resume when browser regains connection after an automatic network pause
  useEffect(() => {
    const handleOnline = () => {
      if (
        activeJob &&
        activeJob.status === 'paused' &&
        activeJob.pauseReason === 'network' &&
        !autoResumingRef.current
      ) {
        autoResumingRef.current = true;
        setTimeout(() => {
          autoResumingRef.current = false;
          launchJobExecution({ mode: 'resume', job: activeJob });
        }, 800);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [activeJob, launchJobExecution]);

  const handleMountFiles = async (fileList: FileList | File[] | null, append: boolean) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith('.zip') || f.type.includes('zip') || f.size > 22
    );
    if (files.length === 0) {
      setMountError('Selecione arquivos no formato .zip.');
      return;
    }
    setMounting(true);
    setMountError(null);
    try {
      clearMediaProfileCache();
      await mountBackupZipFiles(files, { append });
    } catch (err) {
      setMountError(
        err instanceof Error ? err.message : 'Não foi possível ler o arquivo .zip selecionado.'
      );
    } finally {
      setMounting(false);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
      if (appendInputRef.current) appendInputRef.current.value = '';
    }
  };

  const handleUnmount = () => {
    clearMediaProfileCache();
    unmountBackupZip();
    setMountError(null);
  };

  const handleModuleDownload = async (mod: BackupModulePlanItem) => {
    if (isJobRunning) return;
    // If the user already has a paused job for this exact module, resume it directly!
    if (
      activeJob &&
      activeJob.moduleId === mod.id &&
      (activeJob.status === 'paused' || activeJob.status === 'error')
    ) {
      launchJobExecution({ mode: 'resume', job: activeJob });
      return;
    }

    try {
      const bundle = await ensureStaticBundle();
      const files = bundle.moduleFilesById.get(mod.id) || [];
      if (files.length === 0) {
        setPlanError(`Nenhum arquivo mapeado para o módulo ${mod.label}.`);
        return;
      }
      launchJobExecution({
        mode: 'new',
        spec: {
          moduleId: mod.id,
          label: mod.label,
          filename: mod.filename,
          origin: bundle.origin,
          files,
          includeCatalogMeta: mod.module === 'base',
        },
      });
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao iniciar download do módulo.');
    }
  };

  const handleDirectServerModuleDownload = (mod: BackupModulePlanItem) => {
    const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
    const url = `/api/backup/download?url=${encodeURIComponent(target)}&module=${encodeURIComponent(mod.module)}&part=${mod.part}`;
    triggerNativeDownload(url, mod.filename);
    setDownloadedIds((prev) => new Set(prev).add(mod.id));
  };

  const handlePresetDownload = async (moduleKey: 'mp4_ninjas' | 'complete', filename: string) => {
    if (isJobRunning) return;
    if (
      activeJob &&
      activeJob.moduleId === moduleKey &&
      (activeJob.status === 'paused' || activeJob.status === 'error')
    ) {
      launchJobExecution({ mode: 'resume', job: activeJob });
      return;
    }

    setPreparingCustom(true);
    setPlanError(null);
    try {
      const bundle = await ensureStaticBundle();
      if (moduleKey === 'complete') {
        launchJobExecution({
          mode: 'new',
          spec: {
            moduleId: 'complete',
            label: 'Backup Único Completo — Tudo em 1 Arquivo (ZIP64)',
            filename,
            origin: bundle.origin,
            files: bundle.completeFiles,
            includeCatalogMeta: true,
          },
        });
      } else {
        const sourceNinjas =
          ninjas.length > 0 ? ninjas : (await fetchStaticCatalogJson())?.ninjas || [];
        const mp4Ninjas = sourceNinjas.filter((n) => n.hasVideo);
        const files = await resolveStandaloneNinjasFileList(mp4Ninjas, bundle, {
          includeParticles: true,
          includeVideos: true,
          includeAudio: true,
          includeNameArt: true,
        });
        launchJobExecution({
          mode: 'new',
          spec: {
            moduleId: 'mp4_ninjas',
            label: `Todos os ${mp4Ninjas.length || plan?.mp4NinjaCount || 139} Ninjas com Vídeo MP4`,
            filename,
            origin: bundle.origin,
            files,
            includeCatalogMeta: true,
            customNinjaIds: mp4Ninjas.map((n) => n.id),
          },
        });
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao preparar backup completo.');
    } finally {
      setPreparingCustom(false);
    }
  };

  const handleDirectServerPresetDownload = (
    moduleKey: 'mp4_ninjas' | 'complete',
    filename: string
  ) => {
    const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
    const url = `/api/backup/download?url=${encodeURIComponent(target)}&module=${encodeURIComponent(moduleKey)}`;
    triggerNativeDownload(url, filename);
    setDownloadedIds((prev) => new Set(prev).add(moduleKey));
  };

  const handleManualSaveZipNow = async () => {
    if (!activeJob || manualSaving || activeJob.completedPaths.length === 0) return;
    setManualSaving(true);
    setAssemblePercent(5);
    try {
      await assembleAndSaveBackupJobZip(
        activeJob,
        ninjas,
        (pct) => setAssemblePercent(pct),
        { preferFilePicker: true }
      );
      const updated: ResumableBackupJob = {
        ...activeJob,
        status:
          activeJob.completedPaths.length >= activeJob.files.length ? 'completed' : activeJob.status,
        statusMessage: `ZIP "${activeJob.filename}" salvo (${activeJob.completedPaths.length}/${activeJob.files.length} arquivos).`,
      };
      await saveBackupJobRecord(updated);
      setActiveJob(updated);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setPlanError(err instanceof Error ? err.message : 'Erro ao montar o arquivo ZIP.');
      }
    } finally {
      setManualSaving(false);
    }
  };

  const handleDiscardActiveJob = async () => {
    runControllerRef.current?.pause();
    runControllerRef.current = null;
    await clearAllResumableBackupJobs();
    setActiveJob(null);
    setSpeedBytesPerSec(0);
    setEtaSeconds(null);
    setAssemblePercent(0);
    setCurrentFile('');
  };

  const handleSaveAndTestCorsProxy = async () => {
    const trimmed = corsProxyInput.trim();
    setSavedCorsProxy(trimmed);
    setCorsProxySaved(Boolean(trimmed));
    if (!trimmed) {
      setProxyTestResult(null);
      return;
    }
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      const result = await testCorsProxyForMedia(trimmed);
      setProxyTestResult({ ok: result.ok, message: result.message });
    } finally {
      setProxyTesting(false);
    }
  };

  const handleCopyWorkerCode = async () => {
    try {
      await navigator.clipboard.writeText(CLOUDFLARE_WORKER_PROXY_CODE);
      setCopiedWorkerCode(true);
      setTimeout(() => setCopiedWorkerCode(false), 2200);
    } catch {
      setCopiedWorkerCode(false);
    }
  };

  const handleOpenWorkerGuide = () => {
    setShowWorkerGuide(true);
    setTimeout(() => {
      workerPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const handleExportDirectForModule = async (
    mod: BackupModulePlanItem,
    format: 'ps1' | 'sh' | 'txt'
  ) => {
    try {
      const bundle = await ensureStaticBundle();
      const files = bundle.moduleFilesById.get(mod.id) || [];
      if (files.length === 0) {
        setPlanError(`Nenhum arquivo mapeado para o módulo ${mod.label}.`);
        return;
      }
      const spec = {
        moduleId: mod.id,
        label: mod.label,
        filename: mod.filename,
        origin: bundle.origin,
        paths: files.map((f) => f.path),
      };
      if (format === 'ps1') downloadDirectWindowsScript(spec);
      else if (format === 'sh') downloadDirectUnixScript(spec);
      else downloadDirectUrlList(spec);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao gerar script de download direto.');
    }
  };

  const handleExportDirectForActiveJob = (format: 'ps1' | 'sh' | 'txt') => {
    if (!activeJob) return;
    const spec = {
      moduleId: activeJob.moduleId,
      label: activeJob.label,
      filename: activeJob.filename,
      origin: activeJob.origin,
      paths: activeJob.files.map((f) => f.path),
    };
    if (format === 'ps1') downloadDirectWindowsScript(spec);
    else if (format === 'sh') downloadDirectUnixScript(spec);
    else downloadDirectUrlList(spec);
  };

  const filteredCustomNinjas = useMemo(() => {
    const q = customSearch.trim().toLowerCase();
    const list = ninjas.filter((n) => {
      if (!q) return true;
      return (
        n.id.toLowerCase().includes(q) ||
        n.code.toLowerCase().includes(q) ||
        (n.name || '').toLowerCase().includes(q)
      );
    });
    return list.slice(0, 120);
  }, [ninjas, customSearch]);

  const toggleCustomNinja = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDownloadCustomBackup = async () => {
    if (selectedIds.size === 0 || preparingCustom || isJobRunning) return;
    setPreparingCustom(true);
    setCustomStatus('Mapeando sprites, partículas e mídias dos ninjas selecionados...');
    try {
      const bundle = await ensureStaticBundle();
      const selectedList = ninjas.filter((n) => selectedIds.has(n.id));
      const files = await resolveStandaloneNinjasFileList(selectedList, bundle, {
        includeParticles: customIncludeParticles,
        includeVideos: customIncludeVideos,
        includeAudio: customIncludeAudio,
        includeNameArt: customIncludeNameArt,
      });

      if (files.length === 0) {
        throw new Error('Nenhum arquivo encontrado para os ninjas selecionados.');
      }

      const filename =
        selectedList.length === 1
          ? `shinobi_backup_${selectedList[0].id}.zip`
          : `shinobi_backup_personalizado_${selectedList.length}_ninjas.zip`;

      setCustomStatus(
        `Iniciando download retomável de ${files.length.toLocaleString('pt-BR')} arquivos em alta velocidade...`
      );

      launchJobExecution({
        mode: 'new',
        spec: {
          moduleId: `custom-${selectedList.length}`,
          label: `Backup Personalizado (${selectedList.length} ${selectedList.length === 1 ? 'Ninja' : 'Ninjas'})`,
          filename,
          origin: bundle.origin,
          files,
          includeCatalogMeta: true,
          customNinjaIds: selectedList.map((n) => n.id),
        },
      });
    } catch (err) {
      setCustomStatus(err instanceof Error ? err.message : 'Erro ao gerar backup personalizado.');
    } finally {
      setPreparingCustom(false);
    }
  };

  const recommendedModules = useMemo(
    () => (plan?.modules || []).filter((m) => m.recommended),
    [plan]
  );
  const optionalModules = useMemo(
    () => (plan?.modules || []).filter((m) => !m.recommended),
    [plan]
  );

  const jobProgressPct = useMemo(() => {
    if (!activeJob || activeJob.files.length === 0) return 0;
    const processed =
      activeJob.completedPaths.length + (activeJob.corsSkippedPaths?.length || 0);
    return Math.min(100, Math.round((processed / activeJob.files.length) * 100));
  }, [activeJob]);

  return (
    <div className="space-y-6">
      {/* Hidden native file inputs for Android & Desktop */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        className="hidden"
        onChange={(e) => void handleMountFiles(e.target.files, false)}
      />
      <input
        ref={appendInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        className="hidden"
        onChange={(e) => void handleMountFiles(e.target.files, true)}
      />

      {/* SECTION 1: OPEN LOCAL ZIP (100% OFFLINE MODE) */}
      <section className="rounded-lg border border-slate-800 bg-[#131A26] p-4 sm:p-6 space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-50">
                Modo Backup Offline (Leitura Direta do ZIP)
              </h1>
              {offlineZip.active && (
                <span className="inline-flex items-center gap-1.5 rounded bg-emerald-950/90 border border-emerald-500/40 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                  <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>ZIP Offline Ativo</span>
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-slate-400 max-w-3xl leading-relaxed">
              Abra um ou vários arquivos <code className="font-mono text-slate-200">.zip</code> salvos no seu Android ou PC. A leitura usa índice direto via <code className="font-mono text-slate-200">File.slice()</code> sem descompactar tudo na RAM — roda liso mesmo com backups de vários gigabytes e sem depender do servidor do jogo.
            </p>
          </div>

          {offlineZip.active && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {offlineZip.hasCatalog && (
                <button
                  type="button"
                  onClick={onGoToCatalog}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Abrir Catálogo Offline</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleUnmount}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-950/60 transition-colors cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Desconectar ZIP</span>
              </button>
            </div>
          )}
        </div>

        {/* Dropzone / File Selector */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            void handleMountFiles(e.dataTransfer.files, offlineZip.active);
          }}
          className={`rounded-lg border-2 border-dashed p-5 sm:p-6 text-center transition-colors ${
            isDragging
              ? 'border-orange-500 bg-orange-500/10'
              : offlineZip.active
              ? 'border-emerald-500/40 bg-[#0B0F17]'
              : 'border-slate-700 bg-[#0B0F17] hover:border-slate-500'
          }`}
        >
          <div className="mx-auto flex max-w-xl flex-col items-center gap-3">
            <div className="rounded-lg bg-slate-800/80 p-3 text-orange-400">
              {offlineZip.active ? (
                <PackageCheck className="h-6 w-6 text-emerald-400" aria-hidden="true" />
              ) : (
                <FolderOpen className="h-6 w-6" aria-hidden="true" />
              )}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-100">
                {mounting
                  ? 'Indexando arquivos ZIP (lendo índice central)...'
                  : offlineZip.active
                  ? `${offlineZip.archives.length} arquivo(s) ZIP montado(s) · ${offlineZip.stats.totalEntries.toLocaleString('pt-BR')} arquivos indexados`
                  : 'Selecione seus arquivos .zip de backup no Android ou arraste aqui'}
              </p>
              <p className="text-xs text-slate-400">
                Você pode selecionar 1 backup completo, 1 backup personalizado ou todas as partes modulares juntas (Base + Vídeos + Áudios + Partículas + Sprites).
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                disabled={mounting}
                onClick={() => replaceInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {offlineZip.active ? 'Trocar Arquivo(s) ZIP' : 'Abrir Backup .ZIP do Dispositivo'}
                </span>
              </button>

              {offlineZip.active && (
                <button
                  type="button"
                  disabled={mounting}
                  onClick={() => appendInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#131A26] px-4 py-2 text-xs font-semibold text-slate-100 hover:border-orange-500/60 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
                  <span>Adicionar Mais Partes (.ZIP)</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {mountError && (
          <div
            role="alert"
            className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-200"
          >
            {mountError}
          </div>
        )}

        {/* Active ZIP Coverage & Archives List */}
        {offlineZip.active && (
          <div className="space-y-4 border-t border-slate-800/80 pt-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Ninjas no Catálogo</div>
                <div className="mt-1 font-mono text-lg font-semibold text-orange-400 tabular-nums">
                  {offlineZip.stats.catalogNinjas}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Atlas Spine</div>
                <div className="mt-1 font-mono text-lg font-semibold text-slate-100 tabular-nums">
                  {offlineZip.stats.spineAtlases}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Folhas de Sprites</div>
                <div className="mt-1 font-mono text-lg font-semibold text-slate-100 tabular-nums">
                  {offlineZip.stats.spriteSheets}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Partículas e Auras</div>
                <div className="mt-1 font-mono text-lg font-semibold text-purple-300 tabular-nums">
                  {offlineZip.stats.particleFiles}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Vídeos MP4</div>
                <div className="mt-1 font-mono text-lg font-semibold text-cyan-300 tabular-nums">
                  {offlineZip.stats.videosMp4}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Áudios/Vozes MP3</div>
                <div className="mt-1 font-mono text-lg font-semibold text-emerald-300 tabular-nums">
                  {offlineZip.stats.audiosMp3}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B0F17] px-4 py-3">
              <label className="inline-flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={offlineZip.strictOffline}
                  onChange={(e) => setStrictOfflineMode(e.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                <span>
                  <strong className="font-semibold text-slate-100">Modo 100% Offline Estrito:</strong>{' '}
                  bloquear qualquer requisição ao servidor do jogo (usa somente o que estiver dentro dos arquivos ZIP carregados).
                </span>
              </label>
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                Total indexado: {formatSize(offlineZip.stats.totalBytes)}
              </span>
            </div>

            {!offlineZip.hasCatalog && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
                Você carregou uma parte complementar sem o módulo Base. Clique em <strong>Adicionar Mais Partes (.ZIP)</strong> e inclua o arquivo <code className="font-mono">01_shinobi_base_catalogo_esqueletos.zip</code> para listar o catálogo de ninjas.
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">Arquivos ZIP Montados</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {offlineZip.archives.map((arc) => (
                  <div
                    key={arc.id}
                    className="flex items-start justify-between gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Archive className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                        <span className="truncate font-mono text-xs font-semibold text-slate-100" title={arc.fileName}>
                          {arc.fileName}
                        </span>
                      </div>
                      {arc.label && (
                        <div className="mt-0.5 truncate text-[11px] text-slate-400" title={arc.label}>
                          {arc.label}
                        </div>
                      )}
                      <div className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                        {formatSize(arc.fileSize)} · {arc.entryCount.toLocaleString('pt-BR')} arquivos
                        {arc.isStoreFastPath ? ' · Leitura instantânea' : ''}
                      </div>
                    </div>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" aria-hidden="true" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* SECTION 2: HIGH-SPEED RESUMABLE FULL / MODULAR / CUSTOM OFFLINE BACKUPS */}
      <section className="rounded-lg border border-slate-800 bg-[#131A26] p-4 sm:p-6 space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg sm:text-xl font-bold text-slate-50">
                Baixar Backup Completo para seu Android ou PC (.ZIP)
              </h2>
              <span className="inline-flex items-center gap-1 rounded bg-orange-950/80 border border-orange-500/30 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
                <Zap className="h-3 w-3" aria-hidden="true" />
                <span>Alta Velocidade · Retomável</span>
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 max-w-3xl leading-relaxed">
              Baixa até <strong>16 arquivos em paralelo</strong> com checkpoint contínuo no dispositivo (IndexedDB) e empacotamento <strong>ZIP64 STORE</strong> (qualidade máxima sem perdas e leitura instantânea). Se a internet cair ou você fechar a aba, basta clicar em <strong>Retomar de onde parou</strong>.
            </p>
          </div>

          <button
            type="button"
            disabled={loadingPlan}
            onClick={() => void fetchBackupPlan()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50 cursor-pointer shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingPlan ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{loadingPlan ? 'Calculando...' : 'Atualizar Tamanhos'}</span>
          </button>
        </div>

        {/* ACTIVE / PAUSED / COMPLETED RESUMABLE DOWNLOAD PANEL */}
        {activeJob && (
          <div className="rounded-lg border border-orange-500/40 bg-[#0B0F17] p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-semibold text-slate-100">
                    {activeJob.label}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                      activeJob.status === 'running' || activeJob.status === 'assembling'
                        ? 'bg-orange-950 text-orange-300 border border-orange-500/40'
                        : activeJob.status === 'completed'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                        : activeJob.status === 'error'
                        ? 'bg-red-950 text-red-300 border border-red-500/40'
                        : 'bg-amber-950 text-amber-300 border border-amber-500/40'
                    }`}
                  >
                    {activeJob.status === 'running'
                      ? 'Baixando em paralelo'
                      : activeJob.status === 'assembling'
                      ? `Montando ZIP (${assemblePercent}%)`
                      : activeJob.status === 'completed'
                      ? 'Concluído'
                      : activeJob.status === 'error'
                      ? 'Interrompido — Progresso Salvo'
                      : activeJob.pauseReason === 'network'
                      ? 'Sem conexão — Retomará automaticamente'
                      : 'Pausado — Progresso Salvo'}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-400 break-all">
                  {activeJob.filename}
                  {currentFile && activeJob.status === 'running' ? ` · ${currentFile}` : ''}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {activeJob.status === 'running' && (
                  <button
                    type="button"
                    onClick={() => runControllerRef.current?.pause()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-950/60 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/60 cursor-pointer"
                  >
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Pausar</span>
                  </button>
                )}

                {(activeJob.status === 'paused' || activeJob.status === 'error') && (
                  <button
                    type="button"
                    onClick={() => launchJobExecution({ mode: 'resume', job: activeJob })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Retomar de onde parou</span>
                  </button>
                )}

                {activeJob.status !== 'running' &&
                  activeJob.status !== 'assembling' &&
                  activeJob.failedPaths.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        launchJobExecution({
                          mode: 'resume',
                          job: activeJob,
                          retryFailedOnly: true,
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-900/60 cursor-pointer"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Tentar Falhas ({activeJob.failedPaths.length})</span>
                    </button>
                  )}

                {activeJob.status !== 'running' &&
                  activeJob.status !== 'assembling' &&
                  activeJob.completedPaths.length > 0 && (
                    <button
                      type="button"
                      disabled={manualSaving}
                      onClick={() => void handleManualSaveZipNow()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/50 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {manualSaving
                          ? `Montando (${assemblePercent}%)...`
                          : activeJob.status === 'completed'
                          ? 'Baixar ZIP Novamente'
                          : 'Salvar ZIP Parcial Agora'}
                      </span>
                    </button>
                  )}

                {activeJob.status !== 'running' && activeJob.status !== 'assembling' && (
                  <button
                    type="button"
                    onClick={() => void handleDiscardActiveJob()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-[#131A26] px-2.5 py-1.5 text-xs text-slate-300 hover:border-red-500/60 hover:text-red-200 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Limpar</span>
                  </button>
                )}
              </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full transition-all duration-200 ${
                    activeJob.status === 'completed'
                      ? 'bg-emerald-500'
                      : activeJob.status === 'assembling'
                      ? 'bg-cyan-500'
                      : 'bg-orange-500'
                  }`}
                  style={{
                    width: `${
                      activeJob.status === 'assembling' ? Math.max(5, assemblePercent) : jobProgressPct
                    }%`,
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-300 tabular-nums">
                <span>
                  {activeJob.completedPaths.length.toLocaleString('pt-BR')} /{' '}
                  {activeJob.files.length.toLocaleString('pt-BR')} arquivos ({jobProgressPct}%)
                  {' · '}
                  {formatSize(activeJob.downloadedBytes)}
                  {activeJob.totalEstimatedBytes > 0
                    ? ` / ${formatSize(activeJob.totalEstimatedBytes)}`
                    : ''}
                </span>
                <span>
                  {activeJob.status === 'running'
                    ? `${formatSpeed(speedBytesPerSec)} · Restante: ${formatEta(etaSeconds)}`
                    : activeJob.failedPaths.length > 0
                    ? `${activeJob.failedPaths.length} falhas`
                    : ''}
                </span>
              </div>
            </div>

            {activeJob.statusMessage && (
              <p className="text-xs text-slate-300 leading-relaxed">{activeJob.statusMessage}</p>
            )}

            {activeJob.status === 'paused' && activeJob.pauseReason === 'cors' && (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 space-y-2.5">
                <div className="text-xs font-semibold text-cyan-200">
                  Baixar agora em velocidade máxima (2 opções):
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleExportDirectForActiveJob('ps1')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/60 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/60 cursor-pointer"
                  >
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Sem Proxy: Script Windows (.ps1 → gera o ZIP)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportDirectForActiveJob('sh')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/60 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/60 cursor-pointer"
                  >
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Sem Proxy: Android Termux / Linux (.sh)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportDirectForActiveJob('txt')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/60 cursor-pointer"
                  >
                    <FileText className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                    <span>Links Diretos 1DM/ADM (.txt)</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenWorkerGuide}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-950/50 px-3 py-1.5 text-xs font-semibold text-orange-200 hover:bg-orange-900/60 cursor-pointer"
                  >
                    <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Criar Proxy Gratuito (1 min) p/ Baixar no Chrome</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Static mode GitHub Pages direct download & optional free Cloudflare Worker proxy */}
        {staticMode && (
          <div
            ref={workerPanelRef}
            className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3.5 space-y-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2 text-xs text-slate-300 flex-1 min-w-[240px]">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1">
                  <p>
                    <strong className="text-slate-100">GitHub Pages pronto para download:</strong>{' '}
                    Base, Sprites, Partículas e Seleção Personalizada baixam direto em alta velocidade com pausa e retomada automática.
                  </p>
                  <p className="text-slate-400">
                    Para <strong>Vídeos MP4</strong> e <strong>Áudios MP3</strong>: o app tenta relays públicos automaticamente, ou você pode baixar <strong>sem proxy</strong> usando os botões <strong>Script Direto / Links 1DM</strong> nos cartões abaixo — ou ativar um <strong>Cloudflare Worker gratuito</strong> (1 min) para baixar o <code className="font-mono text-slate-200">.ZIP</code> direto no navegador sem limite.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWorkerGuide((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-cyan-300 hover:border-cyan-500/60 cursor-pointer shrink-0"
              >
                <span>Como criar Proxy Grátis (1 min)</span>
                {showWorkerGuide ? (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="url"
                value={corsProxyInput}
                onChange={(e) => {
                  setCorsProxyInput(e.target.value);
                  setProxyTestResult(null);
                }}
                placeholder="URL do seu Cloudflare Worker (ex: https://meu-proxy.workers.dev)"
                className="flex-1 min-w-[220px] rounded-lg border border-slate-800 bg-[#131A26] px-3 py-1.5 text-base sm:text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
              <button
                type="button"
                disabled={proxyTesting}
                onClick={() => void handleSaveAndTestCorsProxy()}
                className="rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-semibold text-slate-100 hover:border-orange-500 disabled:opacity-50 cursor-pointer shrink-0"
              >
                {proxyTesting
                  ? 'Testando...'
                  : corsProxyInput.trim()
                  ? 'Testar e Salvar Proxy'
                  : 'Limpar Proxy'}
              </button>
            </div>

            {proxyTestResult && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  proxyTestResult.ok
                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                    : 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                }`}
              >
                {proxyTestResult.message}
              </div>
            )}

            {showWorkerGuide && (
              <div className="rounded-lg border border-slate-800 bg-[#131A26] p-3.5 space-y-3 text-xs text-slate-300">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-slate-100">
                    Passo a passo (100% gratuito — 100.000 arquivos/dia no Cloudflare Workers):
                  </strong>
                  <button
                    type="button"
                    onClick={() => void handleCopyWorkerCode()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 cursor-pointer"
                  >
                    {copiedWorkerCode ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Código Copiado!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Copiar Código do Worker</span>
                      </>
                    )}
                  </button>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-slate-300 leading-relaxed">
                  <li>
                    Acesse <code className="font-mono text-cyan-300">dash.cloudflare.com</code> (conta gratuita) → <strong>Workers &amp; Pages</strong> → <strong>Create Worker</strong> → <strong>Deploy</strong>.
                  </li>
                  <li>
                    Clique em <strong>Edit code</strong>, apague o texto padrão, cole o código copiado acima e clique em <strong>Deploy</strong>.
                  </li>
                  <li>
                    Copie o endereço gerado (ex: <code className="font-mono text-slate-200">https://shinobi-proxy.seu-nome.workers.dev</code>), cole no campo acima e clique em <strong>Testar e Salvar Proxy</strong>.
                  </li>
                  <li>
                    Pronto! Todos os <strong>Vídeos MP4</strong> e <strong>Áudios MP3</strong> baixam em velocidade máxima direto pelo navegador (inclusive no Android Chrome).
                  </li>
                </ol>
                <pre className="max-h-44 overflow-auto rounded-lg border border-slate-800 bg-[#0B0F17] p-2.5 font-mono text-[11px] text-slate-300 leading-relaxed">
                  {CLOUDFLARE_WORKER_PROXY_CODE}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Mode Tabs */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-[#0B0F17] p-1 w-fit">
          <button
            type="button"
            onClick={() => setDownloadTab('modular')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              downloadTab === 'modular'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Modular / Particionado (Recomendado)
          </button>
          <button
            type="button"
            onClick={() => setDownloadTab('presets')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              downloadTab === 'presets'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Arquivo Único (MP4 / Tudo)
          </button>
          <button
            type="button"
            onClick={() => setDownloadTab('custom')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              downloadTab === 'custom'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Escolher Ninjas ({selectedIds.size})
          </button>
        </div>

        {planError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{planError}</span>
          </div>
        )}

        {/* TAB 1: MODULAR ANDROID BACKUP */}
        {downloadTab === 'modular' && (
          <div className="space-y-4">
            {loadingPlan && !plan ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-28 animate-pulse rounded-lg border border-slate-800 bg-[#0B0F17]"
                  />
                ))}
              </div>
            ) : plan ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] px-4 py-3 text-xs text-slate-300">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                    <span>
                      Dividido em partes seguras (~150–300 MB) para baixar rápido e sem travar no celular. Cada parte salva o progresso automaticamente e retoma de onde parou se cair a rede.
                    </span>
                  </div>
                  <span className="font-mono text-slate-400 tabular-nums shrink-0">
                    Total completo: {formatSize(plan.completeEstimatedBytes)} ({plan.completeFileCount.toLocaleString('pt-BR')} arquivos)
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {recommendedModules.map((mod) => {
                    const isDone = downloadedIds.has(mod.id);
                    const isThisPaused =
                      activeJob?.moduleId === mod.id &&
                      (activeJob.status === 'paused' || activeJob.status === 'error');
                    const isThisRunning = activeJob?.moduleId === mod.id && isJobRunning;
                    const showDirectNoProxyActions =
                      staticMode && mod.requiresCorsProxyInStatic && !corsProxySaved;
                    const icon =
                      mod.module === 'videos' ? (
                        <Clapperboard className="h-4 w-4 text-cyan-400 shrink-0" aria-hidden="true" />
                      ) : mod.module === 'audios' ? (
                        <Music className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                      ) : mod.module === 'particles' ? (
                        <Sparkles className="h-4 w-4 text-purple-400 shrink-0" aria-hidden="true" />
                      ) : mod.module === 'sprites' ? (
                        <Layers className="h-4 w-4 text-orange-400 shrink-0" aria-hidden="true" />
                      ) : (
                        <HardDrive className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                      );
                    return (
                      <div
                        key={mod.id}
                        className="flex flex-col justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B0F17] p-4"
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              {icon}
                              <h3 className="font-display text-sm font-semibold text-slate-100">
                                {mod.label}
                              </h3>
                            </div>
                            <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-200 tabular-nums shrink-0">
                              {formatSize(mod.estimatedBytes)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed">{mod.description}</p>
                          {showDirectNoProxyActions && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              <span className="text-[11px] text-slate-400 mr-0.5">
                                Sem proxy (direto):
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleExportDirectForModule(mod, 'ps1')}
                                title="Baixa script PowerShell para Windows que baixa tudo direto sem CORS e gera o .ZIP pronto"
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#131A26] px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:border-emerald-500/60 cursor-pointer"
                              >
                                <Terminal className="h-3 w-3" aria-hidden="true" />
                                <span>PC .ps1</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleExportDirectForModule(mod, 'sh')}
                                title="Baixa script Bash para Android Termux, Linux ou Mac que baixa tudo direto e gera o .ZIP"
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#131A26] px-2 py-0.5 text-[11px] font-medium text-cyan-300 hover:border-cyan-500/60 cursor-pointer"
                              >
                                <Terminal className="h-3 w-3" aria-hidden="true" />
                                <span>Termux/Linux .sh</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleExportDirectForModule(mod, 'txt')}
                                title="Exporta lista de URLs diretas compatível com 1DM, ADM e IDM"
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#131A26] px-2 py-0.5 text-[11px] font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                              >
                                <FileText className="h-3 w-3" aria-hidden="true" />
                                <span>Links 1DM .txt</span>
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-3">
                          <span className="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                            {mod.filename} · {mod.fileCount.toLocaleString('pt-BR')} arq.
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            {plan.planSource === 'server' && (
                              <button
                                type="button"
                                onClick={() => handleDirectServerModuleDownload(mod)}
                                title="Stream direto pelo servidor local"
                                className="rounded-lg border border-slate-700 bg-[#131A26] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
                              >
                                Stream
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={isJobRunning && !isThisRunning}
                              onClick={() => void handleModuleDownload(mod)}
                              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-45 cursor-pointer shrink-0 ${
                                isThisPaused
                                  ? 'bg-amber-600 text-white hover:bg-amber-500'
                                  : isDone
                                  ? 'border border-emerald-500/40 bg-emerald-950/60 text-emerald-200 hover:bg-emerald-950'
                                  : 'bg-orange-600 text-white hover:bg-orange-500'
                              }`}
                            >
                              {isThisPaused ? (
                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : isDone ? (
                                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              <span>
                                {isThisRunning
                                  ? 'Baixando...'
                                  : isThisPaused
                                  ? 'Retomar Parte'
                                  : isDone
                                  ? 'Baixar Novamente'
                                  : 'Baixar Parte (.ZIP)'}
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {optionalModules.length > 0 && (
                  <div className="space-y-2.5 pt-2">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      Módulos Opcionais (Aba Outros Ativos)
                    </div>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {optionalModules.map((mod) => {
                        const isDone = downloadedIds.has(mod.id);
                        const isThisPaused =
                          activeJob?.moduleId === mod.id &&
                          (activeJob.status === 'paused' || activeJob.status === 'error');
                        return (
                          <div
                            key={mod.id}
                            className="flex flex-col justify-between gap-3 rounded-lg border border-slate-800/80 bg-[#0B0F17]/70 p-4"
                          >
                            <div className="space-y-1">
                              <div className="flex items-start justify-between gap-2">
                                <h3 className="font-display text-sm font-semibold text-slate-200">
                                  {mod.label}
                                </h3>
                                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300 tabular-nums shrink-0">
                                  {formatSize(mod.estimatedBytes)}
                                </span>
                              </div>
                              <p className="text-xs text-slate-500">{mod.description}</p>
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-slate-800/60 pt-2.5">
                              <span className="truncate font-mono text-[11px] text-slate-500">
                                {mod.fileCount.toLocaleString('pt-BR')} arquivos
                              </span>
                              <button
                                type="button"
                                disabled={isJobRunning}
                                onClick={() => void handleModuleDownload(mod)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/60 disabled:opacity-45 cursor-pointer shrink-0"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>
                                  {isThisPaused
                                    ? 'Retomar'
                                    : isDone
                                    ? 'Baixar Novamente'
                                    : 'Baixar Opcional'}
                                </span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* TAB 2: ONE-CLICK SINGLE-FILE PRESETS */}
        {downloadTab === 'presets' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col justify-between gap-4 rounded-lg border border-cyan-500/30 bg-[#0B0F17] p-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Clapperboard className="h-5 w-5 text-cyan-400" aria-hidden="true" />
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Todos os {plan?.mp4NinjaCount || 139} Ninjas com Vídeo MP4 (1 ZIP Autocontido)
                  </h3>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Gera um único arquivo <code className="font-mono text-slate-200">.zip</code> pronto para rodar 100% offline com todos os personagens que possuem vídeo de ultimate/apresentação — incluindo catálogo, esqueletos, folhas de sprites em qualidade máxima, partículas <code className="font-mono text-slate-200">noe_*</code>, auras Susano’o e mídias (com pausa e retomada automática).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={loadingPlan || preparingCustom || isJobRunning}
                  onClick={() =>
                    void handlePresetDownload(
                      'mp4_ninjas',
                      `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`
                    )
                  }
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-45 transition-colors cursor-pointer"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {activeJob?.moduleId === 'mp4_ninjas' && activeJob.status === 'paused'
                      ? `Retomar Pacote dos ${plan?.mp4NinjaCount || 139} Ninjas (.ZIP)`
                      : `Baixar Pacote dos ${plan?.mp4NinjaCount || 139} Ninjas (.ZIP)`}
                  </span>
                </button>
                {plan?.planSource === 'server' && (
                  <button
                    type="button"
                    onClick={() =>
                      handleDirectServerPresetDownload(
                        'mp4_ninjas',
                        `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`
                      )
                    }
                    className="rounded-lg border border-slate-700 bg-[#131A26] px-3 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                  >
                    Stream Servidor
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-lg border border-slate-800 bg-[#0B0F17] p-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-orange-400" aria-hidden="true" />
                  <h3 className="font-display text-base font-semibold text-slate-100">
                    Backup Único Completo — Tudo em 1 Arquivo (ZIP64)
                  </h3>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Junta Base + Partículas + todas as Folhas de Sprites + Vídeos/Áudios ({plan ? formatSize(plan.completeEstimatedBytes) : '~7 GB'}) em um único arquivo ZIP64 com checkpoint retomável. No PC usa gravação direta em disco; no celular recomendamos a aba <strong>Modular / Particionado</strong> para não estourar o limite de arquivo único do navegador mobile.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={loadingPlan || preparingCustom || isJobRunning}
                  onClick={() =>
                    void handlePresetDownload('complete', 'shinobi_backup_completo_tudo.zip')
                  }
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-45 transition-colors cursor-pointer"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {activeJob?.moduleId === 'complete' && activeJob.status === 'paused'
                      ? `Retomar Tudo em 1 ZIP (${plan ? formatSize(plan.completeEstimatedBytes) : ''})`
                      : `Baixar Tudo em 1 ZIP (${plan ? formatSize(plan.completeEstimatedBytes) : '...'})`}
                  </span>
                </button>
                {plan?.planSource === 'server' && (
                  <button
                    type="button"
                    onClick={() =>
                      handleDirectServerPresetDownload('complete', 'shinobi_backup_completo_tudo.zip')
                    }
                    className="rounded-lg border border-slate-700 bg-[#131A26] px-3 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
                  >
                    Stream Servidor
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CUSTOM SELECTION STANDALONE BACKUP */}
        {downloadTab === 'custom' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1 max-w-md">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={customSearch}
                  onChange={(e) => setCustomSearch(e.target.value)}
                  placeholder="Buscar ninja (ex: Sasuke, Naruto, Itachi, Pain, Madara)..."
                  className="w-full rounded-lg border border-slate-800 bg-[#0B0F17] py-2 pl-9 pr-3 text-xs sm:text-sm text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(ninjas.filter((n) => n.hasVideo).map((n) => n.id)))
                  }
                  className="rounded-lg border border-cyan-500/40 bg-cyan-950/40 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-950/70 cursor-pointer"
                >
                  Selecionar Com MP4 ({ninjas.filter((n) => n.hasVideo).length})
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 cursor-pointer"
                >
                  Limpar ({selectedIds.size})
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-800 bg-[#0B0F17] px-4 py-2.5 text-xs text-slate-300">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={customIncludeParticles}
                  onChange={(e) => setCustomIncludeParticles(e.target.checked)}
                  className="accent-orange-500"
                />
                <span>Partículas e Auras (Susano’o / noe_*)</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={customIncludeVideos}
                  onChange={(e) => setCustomIncludeVideos(e.target.checked)}
                  className="accent-orange-500"
                />
                <span>Vídeos MP4</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={customIncludeAudio}
                  onChange={(e) => setCustomIncludeAudio(e.target.checked)}
                  className="accent-orange-500"
                />
                <span>Vozes e Áudios MP3</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={customIncludeNameArt}
                  onChange={(e) => setCustomIncludeNameArt(e.target.checked)}
                  className="accent-orange-500"
                />
                <span>Artes de Nome</span>
              </label>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-[#0B0F17] p-2">
              {filteredCustomNinjas.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  Nenhum personagem encontrado para "{customSearch}".
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredCustomNinjas.map((n) => {
                    const checked = selectedIds.has(n.id);
                    return (
                      <label
                        key={n.id}
                        className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs cursor-pointer transition-colors ${
                          checked
                            ? 'border-orange-500/60 bg-orange-950/30 text-slate-100'
                            : 'border-slate-800/80 bg-[#131A26]/60 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCustomNinja(n.id)}
                            className="accent-orange-500 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{n.name || n.id}</div>
                            <div className="truncate font-mono text-[10px] text-slate-400">
                              {n.id}
                            </div>
                          </div>
                        </div>
                        {n.hasVideo && (
                          <span className="rounded bg-cyan-950/90 border border-cyan-500/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-cyan-300 shrink-0">
                            MP4
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                Gera 1 arquivo <code className="font-mono text-slate-200">.zip</code> autocontido com os sprites, partículas, vídeos e vozes exatos dos ninjas selecionados — retomável caso a conexão oscile.
              </p>
              <button
                type="button"
                disabled={selectedIds.size === 0 || preparingCustom || isJobRunning}
                onClick={() => void handleDownloadCustomBackup()}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {preparingCustom
                    ? 'Preparando...'
                    : `Baixar Backup Personalizado (${selectedIds.size} ${selectedIds.size === 1 ? 'Ninja' : 'Ninjas'})`}
                </span>
              </button>
            </div>

            {customStatus && (
              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] px-4 py-2.5 text-xs text-slate-200">
                {customStatus}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
