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
  Database,
  Download,
  FileText,
  FolderOpen,
  Globe,
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
  Settings2,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import {
  CLOUDFLARE_WORKER_PROXY_CODE,
  downloadDirectUnixScript,
  downloadDirectUrlList,
  downloadDirectWindowsScript,
  downloadFullGameMirrorUnixScript,
  downloadFullGameMirrorWindowsScript,
  testCorsProxyForMedia,
  type FullGameMirrorScope,
} from '../utils/directBackupScript';
import {
  mountBackupZipFiles,
  pickAndMountOfflineZipFiles,
  reauthorizeSavedOfflineHandles,
  setPreferredSourceMode,
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
  buildBackupMetaArchiveBase64,
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
  const [viewMode, setViewMode] = useState<'download' | 'open'>(() =>
    offlineZip.hasMountedArchives || offlineZip.needsReconnect ? 'open' : 'download'
  );
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [downloadTab, setDownloadTab] = useState<'presets' | 'modular' | 'custom'>('presets');

  // Direct zero-CORS script export state (Android Termux / Linux / macOS / Windows)
  const [exportingDirectKey, setExportingDirectKey] = useState<string | null>(null);
  const [showAndroidGuide, setShowAndroidGuide] = useState(false);
  const [copiedTermuxCmd, setCopiedTermuxCmd] = useState(false);
  const [lastShScriptName, setLastShScriptName] = useState(
    'baixar_shinobi_backup_completo_tudo.sh'
  );

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
    const rawFiles = Array.from(fileList);
    const files: File[] = [];
    for (const f of rawFiles) {
      if (f.size < 22) continue;
      if (f.name.toLowerCase().endsWith('.zip') || f.type.includes('zip')) {
        files.push(f);
        continue;
      }
      // Fallback: check ZIP magic bytes ("PK") in case Android strips extension or reports application/octet-stream
      try {
        const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (head[0] === 0x50 && head[1] === 0x4b) {
          files.push(f);
        }
      } catch {
        // ignore unreadable selection
      }
    }
    if (files.length === 0) {
      setMountError('Selecione arquivos válidos no formato .zip.');
      return;
    }
    setMounting(true);
    setMountError(null);
    try {
      clearMediaProfileCache();
      await mountBackupZipFiles(files, { append, activateOffline: true });
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

  const handleSmartPickFiles = async (append: boolean) => {
    setMountError(null);
    setMounting(true);
    try {
      const result = await pickAndMountOfflineZipFiles({ append });
      if (result.status === 'mounted') {
        clearMediaProfileCache();
      } else if (result.status === 'fallback-input') {
        if (append) {
          appendInputRef.current?.click();
        } else {
          replaceInputRef.current?.click();
        }
      }
    } catch (err) {
      setMountError(
        err instanceof Error ? err.message : 'Não foi possível ler o arquivo .zip selecionado.'
      );
    } finally {
      setMounting(false);
    }
  };

  const handleReauthorizeSaved = async () => {
    setMountError(null);
    setMounting(true);
    try {
      clearMediaProfileCache();
      const ok = await reauthorizeSavedOfflineHandles();
      if (!ok) {
        setMountError(
          'Permissão negada ou arquivo movido. Selecione o arquivo .zip novamente.'
        );
      }
    } finally {
      setMounting(false);
    }
  };

  const handleSwitchSourceMode = (mode: 'online' | 'offline') => {
    clearMediaProfileCache();
    setPreferredSourceMode(mode);
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
    setViewMode('download');
    setShowConnectionPanel(true);
    setShowWorkerGuide(true);
    setTimeout(() => {
      workerPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const handleCopyTermuxCommand = async (scriptFilename: string) => {
    const cmd = `termux-setup-storage && bash ~/storage/downloads/${scriptFilename}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedTermuxCmd(true);
      setTimeout(() => setCopiedTermuxCmd(false), 2200);
    } catch {
      setCopiedTermuxCmd(false);
    }
  };

  const handleExportDirectForModule = async (
    mod: BackupModulePlanItem,
    format: 'ps1' | 'sh' | 'txt'
  ) => {
    const key = `${mod.id}-${format}`;
    setExportingDirectKey(key);
    setPlanError(null);
    try {
      const bundle = await ensureStaticBundle();
      const files = bundle.moduleFilesById.get(mod.id) || [];
      if (files.length === 0) {
        setPlanError(`Nenhum arquivo mapeado para o módulo ${mod.label}.`);
        return;
      }
      const metaArchiveBase64 =
        format !== 'txt' && mod.module === 'base'
          ? await buildBackupMetaArchiveBase64({
              origin: bundle.origin,
              moduleId: mod.id,
              label: mod.label,
              expectedFiles: files.length,
              ninjasForCatalog: ninjas,
              includeCatalogMeta: true,
            })
          : undefined;
      const spec = {
        moduleId: mod.id,
        label: mod.label,
        filename: mod.filename,
        origin: bundle.origin,
        paths: files.map((f) => f.path),
        metaArchiveBase64,
      };
      if (format === 'ps1') downloadDirectWindowsScript(spec);
      else if (format === 'sh') {
        downloadDirectUnixScript(spec);
        const base = mod.filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        setLastShScriptName(`baixar_${base}.sh`);
      } else downloadDirectUrlList(spec);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao gerar script de download direto.');
    } finally {
      setExportingDirectKey(null);
    }
  };

  const handleExportDirectForPreset = async (
    moduleKey: 'mp4_ninjas' | 'complete',
    filename: string,
    format: 'ps1' | 'sh' | 'txt'
  ) => {
    const key = `${moduleKey}-${format}`;
    setExportingDirectKey(key);
    setPlanError(null);
    try {
      const bundle = await ensureStaticBundle();
      let files: Array<{ path: string; size: number }>;
      let label: string;
      let customNinjaIds: string[] | undefined;

      if (moduleKey === 'complete') {
        files = bundle.completeFiles;
        label = 'Backup Completo — 100% em 1 Arquivo (ZIP64)';
      } else {
        const sourceNinjas =
          ninjas.length > 0 ? ninjas : (await fetchStaticCatalogJson())?.ninjas || [];
        const mp4Ninjas = sourceNinjas.filter((n) => n.hasVideo);
        files = await resolveStandaloneNinjasFileList(mp4Ninjas, bundle, {
          includeParticles: true,
          includeVideos: true,
          includeAudio: true,
          includeNameArt: true,
        });
        label = `Todos os ${mp4Ninjas.length || plan?.mp4NinjaCount || 139} Ninjas com Vídeo MP4`;
        customNinjaIds = mp4Ninjas.map((n) => n.id);
      }

      const metaArchiveBase64 =
        format !== 'txt'
          ? await buildBackupMetaArchiveBase64({
              origin: bundle.origin,
              moduleId: moduleKey,
              label,
              expectedFiles: files.length,
              ninjasForCatalog: ninjas,
              customNinjaIds,
              includeCatalogMeta: true,
            })
          : undefined;

      const spec = {
        moduleId: moduleKey,
        label,
        filename,
        origin: bundle.origin,
        paths: files.map((f) => f.path),
        metaArchiveBase64,
      };

      if (format === 'ps1') downloadDirectWindowsScript(spec);
      else if (format === 'sh') {
        downloadDirectUnixScript(spec);
        const base = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        setLastShScriptName(`baixar_${base}.sh`);
        setShowAndroidGuide(true);
      } else downloadDirectUrlList(spec);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao gerar script de download direto.');
    } finally {
      setExportingDirectKey(null);
    }
  };

  const handleExportFullGameMirror = async (
    scope: FullGameMirrorScope,
    format: 'sh' | 'ps1'
  ) => {
    const key = `mirror-${scope}-${format}`;
    setExportingDirectKey(key);
    setPlanError(null);
    try {
      const bundle = await ensureStaticBundle();
      const metaArchiveBase64 = await buildBackupMetaArchiveBase64({
        origin: bundle.origin,
        moduleId: scope === 'all_files' ? 'mirror_all_files' : 'mirror_database_only',
        label:
          scope === 'all_files'
            ? 'Cópia Completa do Jogo — Todos os Arquivos (~81.000+)'
            : 'Banco de Dados Completo do Jogo (3.215 tabelas JSON + Código)',
        expectedFiles: scope === 'all_files' ? 81176 : 3600,
        ninjasForCatalog: ninjas,
        includeCatalogMeta: true,
      });

      if (format === 'sh') {
        const scriptName = downloadFullGameMirrorUnixScript({
          origin: bundle.origin,
          scope,
          metaArchiveBase64,
        });
        setLastShScriptName(scriptName);
        setShowAndroidGuide(true);
      } else {
        downloadFullGameMirrorWindowsScript({
          origin: bundle.origin,
          scope,
          metaArchiveBase64,
        });
      }
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : 'Erro ao gerar script de extração completa do jogo.'
      );
    } finally {
      setExportingDirectKey(null);
    }
  };

  const handleExportDirectForCustom = async (format: 'ps1' | 'sh' | 'txt') => {
    if (selectedIds.size === 0 || exportingDirectKey) return;
    const key = `custom-${format}`;
    setExportingDirectKey(key);
    setCustomStatus('Preparando script direto com catálogo e dados de combate...');
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
      const label = `Backup Personalizado (${selectedList.length} ${selectedList.length === 1 ? 'Ninja' : 'Ninjas'})`;

      const metaArchiveBase64 =
        format !== 'txt'
          ? await buildBackupMetaArchiveBase64({
              origin: bundle.origin,
              moduleId: `custom-${selectedList.length}`,
              label,
              expectedFiles: files.length,
              ninjasForCatalog: ninjas,
              customNinjaIds: selectedList.map((n) => n.id),
              includeCatalogMeta: true,
            })
          : undefined;

      const spec = {
        moduleId: `custom-${selectedList.length}`,
        label,
        filename,
        origin: bundle.origin,
        paths: files.map((f) => f.path),
        metaArchiveBase64,
      };

      if (format === 'ps1') downloadDirectWindowsScript(spec);
      else if (format === 'sh') {
        downloadDirectUnixScript(spec);
        const base = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        setLastShScriptName(`baixar_${base}.sh`);
      } else downloadDirectUrlList(spec);

      setCustomStatus(
        `Script gerado com ${files.length.toLocaleString('pt-BR')} arquivos (sem CORS, retomável).`
      );
    } catch (err) {
      setCustomStatus(err instanceof Error ? err.message : 'Erro ao gerar script personalizado.');
    } finally {
      setExportingDirectKey(null);
    }
  };

  const handleExportDirectForActiveJob = async (format: 'ps1' | 'sh' | 'txt') => {
    if (!activeJob) return;
    setExportingDirectKey(`active-${format}`);
    try {
      const metaArchiveBase64 =
        format !== 'txt' && activeJob.includeCatalogMeta
          ? await buildBackupMetaArchiveBase64({
              origin: activeJob.origin,
              moduleId: activeJob.moduleId,
              label: activeJob.label,
              expectedFiles: activeJob.files.length,
              ninjasForCatalog: ninjas,
              customNinjaIds: activeJob.customNinjaIds,
              includeCatalogMeta: true,
            })
          : undefined;
      const spec = {
        moduleId: activeJob.moduleId,
        label: activeJob.label,
        filename: activeJob.filename,
        origin: activeJob.origin,
        paths: activeJob.files.map((f) => f.path),
        metaArchiveBase64,
      };
      if (format === 'ps1') downloadDirectWindowsScript(spec);
      else if (format === 'sh') {
        downloadDirectUnixScript(spec);
        const base = activeJob.filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        setLastShScriptName(`baixar_${base}.sh`);
      } else downloadDirectUrlList(spec);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao gerar script de download direto.');
    } finally {
      setExportingDirectKey(null);
    }
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

  const videoNinjaCount = useMemo(() => ninjas.filter((n) => n.hasVideo).length, [ninjas]);

  return (
    <div className="space-y-6">
      {/* Hidden native file inputs for Android & Desktop (no MIME accept filter so Android Chrome shows Termux-created >4GB ZIPs) */}
      <input
        ref={replaceInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleMountFiles(e.target.files, false)}
      />
      <input
        ref={appendInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleMountFiles(e.target.files, true)}
      />

      {/* Unified Page Header */}
      <div className="flex flex-col gap-4 border-b border-white/[0.07] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50">Backup</h1>
          <p className="mt-1 text-xs text-slate-400 tabular-nums">
            {offlineZip.active
              ? `Modo offline ativo · ${offlineZip.archives.length} ZIP · ${offlineZip.stats.totalEntries.toLocaleString('pt-BR')} arquivos`
              : offlineZip.hasMountedArchives
              ? `Site do jogo ativo · ${offlineZip.archives.length} ZIP carregado em espera`
              : 'Baixe pacotes para uso sem internet ou abra arquivos .zip salvos no dispositivo'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-white/[0.07] bg-[#11141C] p-1">
            <button
              type="button"
              onClick={() => setViewMode('download')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                viewMode === 'download'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Baixar backup
            </button>
            <button
              type="button"
              onClick={() => setViewMode('open')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                viewMode === 'open'
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <span>Abrir ZIP local</span>
              {offlineZip.active ? (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              ) : offlineZip.hasMountedArchives || offlineZip.needsReconnect ? (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              ) : null}
            </button>
          </div>

          {viewMode === 'download' && staticMode && (
            <button
              type="button"
              onClick={() => setShowConnectionPanel((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                showConnectionPanel || corsProxySaved
                  ? 'border-orange-500/40 bg-orange-500/10 text-orange-300'
                  : 'border-white/10 bg-[#11141C] text-slate-300 hover:border-white/20 hover:text-white'
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{corsProxySaved ? 'Proxy ativo' : 'Conexão'}</span>
            </button>
          )}

          {viewMode === 'download' && (
            <button
              type="button"
              disabled={loadingPlan}
              onClick={() => void fetchBackupPlan()}
              title="Recalcular tamanhos dos pacotes"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#11141C] px-3 py-2 text-xs font-medium text-slate-300 hover:border-white/20 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loadingPlan ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">{loadingPlan ? 'Atualizando...' : 'Atualizar'}</span>
            </button>
          )}
        </div>
      </div>

      {/* ACTIVE / PAUSED / COMPLETED RESUMABLE DOWNLOAD PANEL (Visible across both views if active) */}
      {activeJob && (
        <div className="rounded-xl border border-orange-500/35 bg-[#11141C] p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    activeJob.status === 'running' || activeJob.status === 'assembling'
                      ? 'bg-orange-400 animate-pulse'
                      : activeJob.status === 'completed'
                      ? 'bg-emerald-400'
                      : activeJob.status === 'error'
                      ? 'bg-red-400'
                      : 'bg-amber-400'
                  }`}
                  aria-hidden="true"
                />
                <span className="font-display text-sm font-semibold text-slate-100">
                  {activeJob.label}
                </span>
                <span className="text-xs text-slate-400">
                  ·{' '}
                  {activeJob.status === 'running'
                    ? 'Baixando'
                    : activeJob.status === 'assembling'
                    ? `Montando ZIP (${assemblePercent}%)`
                    : activeJob.status === 'completed'
                    ? 'Concluído'
                    : activeJob.status === 'error'
                    ? 'Interrompido — progresso salvo'
                    : activeJob.pauseReason === 'network'
                    ? 'Sem conexão — retomará automaticamente'
                    : 'Pausado — progresso salvo'}
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-500 break-all">
                {activeJob.filename}
                {currentFile && activeJob.status === 'running' ? ` · ${currentFile}` : ''}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeJob.status === 'running' && (
                <button
                  type="button"
                  onClick={() => runControllerRef.current?.pause()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20 cursor-pointer"
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
                  <span>Retomar</span>
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/20 cursor-pointer"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Tentar falhas ({activeJob.failedPaths.length})</span>
                  </button>
                )}

              {activeJob.status !== 'running' &&
                activeJob.status !== 'assembling' &&
                activeJob.completedPaths.length > 0 && (
                  <button
                    type="button"
                    disabled={manualSaving}
                    onClick={() => void handleManualSaveZipNow()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/20 disabled:opacity-40 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {manualSaving
                        ? `Montando (${assemblePercent}%)...`
                        : activeJob.status === 'completed'
                        ? 'Baixar novamente'
                        : 'Salvar parcial'}
                    </span>
                  </button>
                )}

              {activeJob.status !== 'running' && activeJob.status !== 'assembling' && (
                <button
                  type="button"
                  onClick={() => void handleDiscardActiveJob()}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 text-xs text-slate-400 hover:border-red-500/40 hover:text-red-300 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Limpar</span>
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full transition-all duration-200 ${
                  activeJob.status === 'completed' ? 'bg-emerald-500' : 'bg-orange-500'
                }`}
                style={{
                  width: `${
                    activeJob.status === 'assembling'
                      ? Math.max(5, assemblePercent)
                      : jobProgressPct
                  }%`,
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-400 tabular-nums">
              <span>
                {activeJob.completedPaths.length.toLocaleString('pt-BR')} /{' '}
                {activeJob.files.length.toLocaleString('pt-BR')} arquivos ({jobProgressPct}%) ·{' '}
                {formatSize(activeJob.downloadedBytes)}
                {activeJob.totalEstimatedBytes > 0
                  ? ` / ${formatSize(activeJob.totalEstimatedBytes)}`
                  : ''}
              </span>
              <span>
                {activeJob.status === 'running'
                  ? `${formatSpeed(speedBytesPerSec)} · restante ${formatEta(etaSeconds)}`
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
            <div className="border-t border-white/[0.06] pt-3 space-y-2.5">
              <div className="text-xs font-medium text-slate-200">
                Alternativas de download direto para este pacote:
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={Boolean(exportingDirectKey)}
                  onClick={() => void handleExportDirectForActiveJob('sh')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 cursor-pointer"
                >
                  <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Android Termux / Linux (.sh)</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(exportingDirectKey)}
                  onClick={() => void handleExportDirectForActiveJob('ps1')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer"
                >
                  <Terminal className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  <span>Windows (.ps1)</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(exportingDirectKey)}
                  onClick={() => void handleExportDirectForActiveJob('txt')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer"
                >
                  <FileText className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  <span>Links 1DM / ADM (.txt)</span>
                </button>
                <button
                  type="button"
                  onClick={handleOpenWorkerGuide}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
                >
                  <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Configurar proxy</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIEW 1: OPEN LOCAL ZIP (OFFLINE MODE) */}
      {viewMode === 'open' && (
        <section className="space-y-5">
          {offlineZip.needsReconnect && !offlineZip.hasMountedArchives && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="text-xs font-semibold text-amber-200">
                  Preferência salva: Modo offline
                </div>
                <div className="text-xs text-slate-300 truncate">
                  Último pacote:{' '}
                  <span className="font-mono text-amber-100">
                    {offlineZip.savedArchives.map((a) => `${a.fileName} (${formatSize(a.fileSize)})`).join(', ')}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  {offlineZip.canOneClickReauthorize
                    ? 'Toque no botão abaixo para reativar imediatamente sem precisar procurar o arquivo.'
                    : 'Por segurança do navegador móvel para arquivos grandes (> 250 MB), confirme o arquivo para reabrir ou volte ao site do jogo.'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={mounting}
                  onClick={() =>
                    offlineZip.canOneClickReauthorize
                      ? void handleReauthorizeSaved()
                      : void handleSmartPickFiles(false)
                  }
                  className="rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {mounting
                    ? 'Reconectando...'
                    : offlineZip.canOneClickReauthorize
                    ? 'Reativar backup (1 clique)'
                    : 'Reconectar .ZIP salvo'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchSourceMode('online');
                    onGoToCatalog();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/30 transition-colors cursor-pointer"
                >
                  <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Usar site do jogo</span>
                </button>
              </div>
            </div>
          )}

          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              void handleMountFiles(e.dataTransfer.files, offlineZip.hasMountedArchives);
            }}
            className={`rounded-xl border border-dashed p-8 text-center transition-colors ${
              isDragging
                ? 'border-orange-500 bg-orange-500/10'
                : offlineZip.active
                ? 'border-emerald-500/35 bg-[#11141C]'
                : offlineZip.hasMountedArchives
                ? 'border-amber-500/35 bg-[#11141C]'
                : 'border-white/15 bg-[#11141C] hover:border-white/25'
            }`}
          >
            <div className="mx-auto flex max-w-md flex-col items-center gap-3">
              <div className="rounded-lg bg-[#090B10] border border-white/[0.07] p-3">
                {offlineZip.hasMountedArchives ? (
                  <PackageCheck
                    className={`h-5 w-5 ${offlineZip.active ? 'text-emerald-400' : 'text-amber-400'}`}
                    aria-hidden="true"
                  />
                ) : (
                  <FolderOpen className="h-5 w-5 text-orange-400" aria-hidden="true" />
                )}
              </div>

              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-100">
                  {mounting
                    ? 'Indexando arquivos ZIP...'
                    : offlineZip.active
                    ? `${offlineZip.archives.length} pacote(s) ativo(s) em modo offline`
                    : offlineZip.hasMountedArchives
                    ? `${offlineZip.archives.length} pacote(s) pronto(s) (usando site do jogo agora)`
                    : 'Arraste seus arquivos .zip ou selecione do dispositivo'}
                </p>
                <p className="text-xs text-slate-400">
                  A preferência offline é salva automaticamente. Compatível com backup completo (&gt; 4 GB do Termux), personalizado ou múltiplas partes.
                </p>
                <p className="text-[11px] text-slate-500">
                  No Android, se o arquivo não aparecer em &ldquo;Recentes&rdquo;, toque no menu (☰) → armazenamento do aparelho → Download.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={mounting}
                  onClick={() => void handleSmartPickFiles(false)}
                  className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{offlineZip.hasMountedArchives ? 'Trocar arquivos' : 'Selecionar .ZIP'}</span>
                </button>

                {offlineZip.hasMountedArchives && (
                  <button
                    type="button"
                    disabled={mounting}
                    onClick={() => void handleSmartPickFiles(true)}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-[#090B10] px-4 py-2 text-xs font-medium text-slate-200 hover:border-white/20 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Adicionar partes</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {mountError && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-xs text-red-200"
            >
              {mountError}
            </div>
          )}

          {offlineZip.hasMountedArchives && (
            <div className="rounded-xl border border-white/[0.07] bg-[#11141C] overflow-hidden">
              {/* Inline Hairline Stats Row */}
              <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-y sm:divide-y-0 divide-white/[0.06] border-b border-white/[0.06]">
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Ninjas</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.catalogNinjas}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Esqueletos</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.spineAtlases}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Sprites</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.spriteSheets}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Partículas</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.particleFiles}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Vídeos</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.videosMp4}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[11px] text-slate-500">Áudios</div>
                  <div className="mt-0.5 font-mono text-base font-semibold text-slate-100 tabular-nums">
                    {offlineZip.stats.audiosMp3}
                  </div>
                </div>
              </div>

              {/* Strict Offline + Quick Source Toggle + Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
                <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={offlineZip.strictOffline}
                    onChange={(e) => setStrictOfflineMode(e.target.checked)}
                    className="h-3.5 w-3.5 accent-orange-500"
                  />
                  <span>Modo offline estrito (bloquear requisições externas)</span>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums mr-1">
                    {formatSize(offlineZip.stats.totalBytes)}
                  </span>
                  {offlineZip.active ? (
                    <button
                      type="button"
                      onClick={() => handleSwitchSourceMode('online')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/40 hover:text-orange-200 transition-colors cursor-pointer"
                    >
                      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Usar site do jogo</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSwitchSourceMode('offline')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors cursor-pointer"
                    >
                      <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Ativar arquivo offline</span>
                    </button>
                  )}
                  {offlineZip.hasCatalog && (
                    <button
                      type="button"
                      onClick={onGoToCatalog}
                      className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
                    >
                      Abrir Catálogo
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleUnmount}
                    className="rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-red-500/40 hover:text-red-300 transition-colors cursor-pointer"
                  >
                    Desconectar
                  </button>
                </div>
              </div>

              {!offlineZip.hasCatalog && (
                <div className="border-b border-white/[0.06] bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
                  Adicione também a parte Base (<span className="font-mono">01_shinobi_base_catalogo_esqueletos.zip</span>) para listar todos os personagens.
                </div>
              )}

              {/* Mounted Archives Hairline List */}
              <div className="divide-y divide-white/[0.05]">
                {offlineZip.archives.map((arc) => (
                  <div
                    key={arc.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Archive className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="truncate font-mono text-slate-100" title={arc.fileName}>
                          {arc.fileName}
                        </div>
                        {arc.label && (
                          <div className="truncate text-[11px] text-slate-500" title={arc.label}>
                            {arc.label}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] text-slate-400 tabular-nums">
                      <span>
                        {formatSize(arc.fileSize)} · {arc.entryCount.toLocaleString('pt-BR')} arq.
                      </span>
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* VIEW 2: DOWNLOAD BACKUPS */}
      {viewMode === 'download' && (
        <section className="space-y-5">
          {/* Collapsible Proxy / Connection Panel (Static Mode Only) */}
          {staticMode && showConnectionPanel && (
            <div
              ref={workerPanelRef}
              className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-semibold text-slate-100">
                    Proxy para vídeos e áudios no navegador
                  </h2>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Opcional. Necessário apenas se o navegador bloquear o download direto de vídeos MP4 ou áudios MP3.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowWorkerGuide((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white cursor-pointer shrink-0"
                >
                  <span>Como configurar</span>
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
                  placeholder="https://meu-proxy.workers.dev"
                  className="flex-1 min-w-[220px] rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-sm sm:text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={proxyTesting}
                  onClick={() => void handleSaveAndTestCorsProxy()}
                  className="rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {proxyTesting
                    ? 'Testando...'
                    : corsProxyInput.trim()
                    ? 'Testar e salvar'
                    : 'Limpar proxy'}
                </button>
              </div>

              {proxyTestResult && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    proxyTestResult.ok
                      ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-200'
                      : 'border-amber-500/30 bg-amber-950/30 text-amber-200'
                  }`}
                >
                  {proxyTestResult.message}
                </div>
              )}

              {showWorkerGuide && (
                <div className="border-t border-white/[0.06] pt-3 space-y-2.5 text-xs text-slate-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-200">
                      Passo a passo (Cloudflare Workers gratuito)
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyWorkerCode()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-white/25 cursor-pointer"
                    >
                      {copiedWorkerCode ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                          <span>Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copiar código</span>
                        </>
                      )}
                    </button>
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-400 leading-relaxed">
                    <li>
                      Acesse <span className="font-mono text-slate-200">dash.cloudflare.com</span> → Workers &amp; Pages → Create Worker → Deploy.
                    </li>
                    <li>
                      Clique em Edit code, cole o código copiado e clique em Deploy.
                    </li>
                    <li>
                      Cole a URL gerada no campo acima e clique em Testar e salvar.
                    </li>
                  </ol>
                  <pre className="max-h-40 overflow-auto rounded-lg border border-white/[0.07] bg-[#090B10] p-2.5 font-mono text-[11px] text-slate-300 leading-relaxed">
                    {CLOUDFLARE_WORKER_PROXY_CODE}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Mode Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center rounded-lg border border-white/[0.07] bg-[#11141C] p-1">
              <button
                type="button"
                onClick={() => setDownloadTab('presets')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  downloadTab === 'presets'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Arquivo único
              </button>
              <button
                type="button"
                onClick={() => setDownloadTab('modular')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  downloadTab === 'modular'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Particionado
              </button>
              <button
                type="button"
                onClick={() => setDownloadTab('custom')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer tabular-nums ${
                  downloadTab === 'custom'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Personalizado{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
              </button>
            </div>

            {plan && (
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                Acervo completo · {formatSize(plan.completeEstimatedBytes)} ·{' '}
                {plan.completeFileCount.toLocaleString('pt-BR')} arquivos
              </span>
            )}
          </div>

          {planError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/25 px-4 py-3 text-xs text-amber-200"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{planError}</span>
            </div>
          )}

          {/* SUB-TAB 1: MODULAR / PARTITIONED */}
          {downloadTab === 'modular' && (
            <div className="space-y-5">
              {loadingPlan && !plan ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-28 animate-pulse rounded-xl border border-white/[0.06] bg-[#11141C]"
                    />
                  ))}
                </div>
              ) : plan ? (
                <>
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
                          <Clapperboard className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                        ) : mod.module === 'audios' ? (
                          <Music className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                        ) : mod.module === 'particles' ? (
                          <Sparkles className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                        ) : mod.module === 'sprites' ? (
                          <Layers className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                        ) : (
                          <HardDrive className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                        );
                      return (
                        <div
                          key={mod.id}
                          className="flex flex-col justify-between gap-3 rounded-xl border border-white/[0.07] bg-[#11141C] p-4"
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                {icon}
                                <h3 className="font-display text-sm font-semibold text-slate-100 truncate">
                                  {mod.label}
                                </h3>
                              </div>
                              <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
                                {formatSize(mod.estimatedBytes)}
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 leading-relaxed">
                              {mod.description}
                            </p>
                            {showDirectNoProxyActions && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                <span className="text-[11px] text-slate-500">Direto (sem CORS):</span>
                                <button
                                  type="button"
                                  disabled={Boolean(exportingDirectKey)}
                                  onClick={() => void handleExportDirectForModule(mod, 'sh')}
                                  className="rounded border border-orange-500/35 bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-300 hover:bg-orange-500/20 disabled:opacity-40 cursor-pointer"
                                >
                                  Android .sh
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(exportingDirectKey)}
                                  onClick={() => void handleExportDirectForModule(mod, 'ps1')}
                                  className="rounded border border-white/10 bg-[#090B10] px-2 py-0.5 text-[11px] text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                                >
                                  Windows .ps1
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(exportingDirectKey)}
                                  onClick={() => void handleExportDirectForModule(mod, 'txt')}
                                  className="rounded border border-white/10 bg-[#090B10] px-2 py-0.5 text-[11px] text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                                >
                                  Links .txt
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                            <span className="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                              {mod.fileCount.toLocaleString('pt-BR')} arquivos
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {plan.planSource === 'server' && (
                                <button
                                  type="button"
                                  onClick={() => handleDirectServerModuleDownload(mod)}
                                  title="Download direto pelo servidor"
                                  className="rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:border-white/25 cursor-pointer"
                                >
                                  Direto
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isJobRunning && !isThisRunning}
                                onClick={() => void handleModuleDownload(mod)}
                                className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 cursor-pointer shrink-0 ${
                                  isThisPaused
                                    ? 'bg-amber-600 text-white hover:bg-amber-500'
                                    : isDone
                                    ? 'border border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
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
                                    ? 'Retomar'
                                    : isDone
                                    ? 'Baixar novamente'
                                    : 'Baixar'}
                                </span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {optionalModules.length > 0 && (
                    <div className="rounded-xl border border-white/[0.07] bg-[#11141C] overflow-hidden">
                      <div className="border-b border-white/[0.06] px-4 py-2.5 text-xs font-medium text-slate-400">
                        Pacotes opcionais
                      </div>
                      <div className="divide-y divide-white/[0.05]">
                        {optionalModules.map((mod) => {
                          const isDone = downloadedIds.has(mod.id);
                          const isThisPaused =
                            activeJob?.moduleId === mod.id &&
                            (activeJob.status === 'paused' || activeJob.status === 'error');
                          return (
                            <div
                              key={mod.id}
                              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-medium text-slate-200">{mod.label}</div>
                                <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                                  {formatSize(mod.estimatedBytes)} ·{' '}
                                  {mod.fileCount.toLocaleString('pt-BR')} arquivos
                                </div>
                              </div>
                              <button
                                type="button"
                                disabled={isJobRunning}
                                onClick={() => void handleModuleDownload(mod)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer shrink-0"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>
                                  {isThisPaused
                                    ? 'Retomar'
                                    : isDone
                                    ? 'Baixar novamente'
                                    : 'Baixar'}
                                </span>
                              </button>
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

          {/* SUB-TAB 2: SINGLE-FILE PRESETS */}
          {downloadTab === 'presets' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* COMPLETE SINGLE-ZIP BACKUP (100% OF EVERYTHING) */}
                <div className="flex flex-col justify-between gap-4 rounded-xl border border-orange-500/25 bg-[#11141C] p-5">
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <HardDrive className="h-4 w-4 text-orange-400 shrink-0" aria-hidden="true" />
                        <h3 className="font-display text-base font-semibold text-slate-100">
                          Backup completo — 100% tudo
                        </h3>
                      </div>
                      <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
                        {plan ? formatSize(plan.completeEstimatedBytes) : '...'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Um único arquivo <span className="font-mono text-slate-300">.zip</span> com
                      todo o acervo: catálogo, sprites, partículas, ícones de skills, ativos/emojis,
                      vídeos MP4, áudios MP3 e dados de combate/perseguição.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={loadingPlan || Boolean(exportingDirectKey)}
                        onClick={() =>
                          void handleExportDirectForPreset(
                            'complete',
                            'shinobi_backup_completo_tudo.zip',
                            'sh'
                          )
                        }
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'complete-sh'
                            ? 'Preparando script...'
                            : 'Android — 1 ZIP (.sh)'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={loadingPlan || preparingCustom || isJobRunning}
                        onClick={() =>
                          void handlePresetDownload('complete', 'shinobi_backup_completo_tudo.zip')
                        }
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {activeJob?.moduleId === 'complete' && activeJob.status === 'paused'
                            ? 'Retomar'
                            : 'Navegador'}
                        </span>
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {plan ? `${plan.completeFileCount.toLocaleString('pt-BR')} arquivos` : '...'}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={loadingPlan || Boolean(exportingDirectKey)}
                          onClick={() =>
                            void handleExportDirectForPreset(
                              'complete',
                              'shinobi_backup_completo_tudo.zip',
                              'ps1'
                            )
                          }
                          className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                        >
                          {exportingDirectKey === 'complete-ps1' ? 'Gerando...' : 'Windows .ps1'}
                        </button>
                        <button
                          type="button"
                          disabled={loadingPlan || Boolean(exportingDirectKey)}
                          onClick={() =>
                            void handleExportDirectForPreset(
                              'complete',
                              'shinobi_backup_completo_tudo.zip',
                              'txt'
                            )
                          }
                          className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                        >
                          Links 1DM .txt
                        </button>
                        {plan?.planSource === 'server' && (
                          <button
                            type="button"
                            onClick={() =>
                              handleDirectServerPresetDownload(
                                'complete',
                                'shinobi_backup_completo_tudo.zip'
                              )
                            }
                            className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white cursor-pointer"
                          >
                            Servidor direto
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* MP4 NINJAS SINGLE-ZIP PRESET */}
                <div className="flex flex-col justify-between gap-4 rounded-xl border border-white/[0.07] bg-[#11141C] p-5">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Clapperboard className="h-4 w-4 text-orange-400 shrink-0" aria-hidden="true" />
                      <h3 className="font-display text-base font-semibold text-slate-100">
                        Ninjas com vídeo ({plan?.mp4NinjaCount || 139})
                      </h3>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Um único arquivo <span className="font-mono text-slate-300">.zip</span> com
                      todos os personagens que possuem vídeo, incluindo sprites, partículas, ícones
                      de skills, auras, combate e áudios.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={loadingPlan || Boolean(exportingDirectKey)}
                        onClick={() =>
                          void handleExportDirectForPreset(
                            'mp4_ninjas',
                            `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`,
                            'sh'
                          )
                        }
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'mp4_ninjas-sh'
                            ? 'Preparando script...'
                            : 'Android — 1 ZIP (.sh)'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={loadingPlan || preparingCustom || isJobRunning}
                        onClick={() =>
                          void handlePresetDownload(
                            'mp4_ninjas',
                            `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`
                          )
                        }
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {activeJob?.moduleId === 'mp4_ninjas' && activeJob.status === 'paused'
                            ? 'Retomar'
                            : 'Navegador'}
                        </span>
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {plan?.mp4NinjaCount || 139} personagens selecionados
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={loadingPlan || Boolean(exportingDirectKey)}
                          onClick={() =>
                            void handleExportDirectForPreset(
                              'mp4_ninjas',
                              `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`,
                              'ps1'
                            )
                          }
                          className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                        >
                          {exportingDirectKey === 'mp4_ninjas-ps1' ? 'Gerando...' : 'Windows .ps1'}
                        </button>
                        <button
                          type="button"
                          disabled={loadingPlan || Boolean(exportingDirectKey)}
                          onClick={() =>
                            void handleExportDirectForPreset(
                              'mp4_ninjas',
                              `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`,
                              'txt'
                            )
                          }
                          className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer"
                        >
                          Links 1DM .txt
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
                            className="rounded border border-white/10 bg-[#090B10] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-white/25 hover:text-white cursor-pointer"
                          >
                            Servidor direto
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Full Game Mirror & Decrypted Database Section */}
              <div className="rounded-xl border border-white/[0.08] bg-[#11141C] overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-orange-400 shrink-0" aria-hidden="true" />
                    <h3 className="font-display text-sm font-semibold text-slate-100">
                      Cópia completa do jogo &amp; Banco de Dados (recriar do zero)
                    </h3>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    Manifesto ao vivo · 81.176 arquivos · 3.215 tabelas JSON
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/[0.06]">
                  {/* Full 81,176-file mirror */}
                  <div className="flex flex-col justify-between gap-4 p-5">
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          Todos os arquivos do jogo
                        </span>
                        <span className="font-mono text-xs text-slate-400 tabular-nums">
                          ~13,0 GB
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        Baixa 100% do servidor: todos os sprites, mapas vivos, UI, retratos, itens,
                        vídeos, áudios, scripts JS/CSS, libs Phaser/Spine e todas as{' '}
                        <span className="text-slate-200 font-medium">3.215 tabelas</span>{' '}
                        descriptografadas em JSON legível.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={Boolean(exportingDirectKey)}
                        onClick={() => void handleExportFullGameMirror('all_files', 'sh')}
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'mirror-all_files-sh'
                            ? 'Preparando...'
                            : 'Android Termux (.sh)'}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(exportingDirectKey)}
                        onClick={() => void handleExportFullGameMirror('all_files', 'ps1')}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Terminal className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'mirror-all_files-ps1'
                            ? 'Gerando...'
                            : 'Windows .ps1'}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Database + client code only */}
                  <div className="flex flex-col justify-between gap-4 p-5">
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          Somente Banco de Dados + Código
                        </span>
                        <span className="font-mono text-xs text-slate-400 tabular-nums">
                          ~50 MB · ~15s
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        Baixa rapidamente todas as{' '}
                        <span className="text-slate-200 font-medium">3.215 tabelas JSON</span>{' '}
                        descriptografadas com nomes originais (<span className="font-mono text-slate-300">herois.json</span>,{' '}
                        <span className="font-mono text-slate-300">skills.json</span>,{' '}
                        <span className="font-mono text-slate-300">pt.json</span>,{' '}
                        <span className="font-mono text-slate-300">RoleModel.json</span>), layouts de tela, scripts JS/CSS e libs.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={Boolean(exportingDirectKey)}
                        onClick={() => void handleExportFullGameMirror('database_only', 'sh')}
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3.5 py-2 text-xs font-semibold text-orange-300 hover:bg-orange-500/20 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'mirror-database_only-sh'
                            ? 'Preparando...'
                            : 'Android Termux (.sh)'}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(exportingDirectKey)}
                        onClick={() => void handleExportFullGameMirror('database_only', 'ps1')}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        <Terminal className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                        <span>
                          {exportingDirectKey === 'mirror-database_only-ps1'
                            ? 'Gerando...'
                            : 'Windows .ps1'}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Discreet Collapsible Android Termux Guide */}
              <div className="rounded-xl border border-white/[0.07] bg-[#11141C] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAndroidGuide((v) => !v)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Terminal className="h-3.5 w-3.5 text-orange-400 shrink-0" aria-hidden="true" />
                    <span className="text-xs font-medium text-slate-200 truncate">
                      Como executar no Android (Termux) — 16 conexões diretas, sem erro de CORS
                    </span>
                  </div>
                  {showAndroidGuide ? (
                    <ChevronUp className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                  )}
                </button>

                {showAndroidGuide && (
                  <div className="border-t border-white/[0.06] px-4 py-3.5 space-y-3 text-xs text-slate-300">
                    <ol className="list-decimal list-inside space-y-1.5 text-xs text-slate-400 leading-relaxed">
                      <li>
                        Toque em <span className="text-slate-200 font-medium">Android — 1 ZIP (.sh)</span> acima para salvar o script na pasta Downloads.
                      </li>
                      <li>
                        Abra o aplicativo <span className="text-slate-200 font-medium">Termux</span> (instale pelo F-Droid ou GitHub) e cole o comando abaixo.
                      </li>
                      <li>
                        O script baixa tudo em 16 conexões simultâneas, monta 1 único <span className="font-mono text-slate-200">.zip</span> direto em Downloads e limpa o cache automaticamente. Depois, selecione o arquivo em <span className="text-slate-200 font-medium">Abrir ZIP local</span>.
                      </li>
                    </ol>

                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.07] bg-[#090B10] px-3 py-2">
                      <code className="font-mono text-[11px] text-orange-300 break-all">
                        termux-setup-storage &amp;&amp; bash ~/storage/downloads/{lastShScriptName}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopyTermuxCommand(lastShScriptName)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-[#11141C] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-white/25 cursor-pointer shrink-0"
                      >
                        {copiedTermuxCmd ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
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

                    <p className="text-[11px] text-slate-500">
                      Se a internet cair ou o app fechar, execute o mesmo comando novamente para continuar exatamente do arquivo onde parou. No Linux ou macOS, basta rodar <span className="font-mono text-slate-400">bash {lastShScriptName}</span>.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SUB-TAB 3: CUSTOM SELECTION */}
          {downloadTab === 'custom' && (
            <div className="rounded-xl border border-white/[0.07] bg-[#11141C] overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-white/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative flex-1 max-w-sm">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={customSearch}
                    onChange={(e) => setCustomSearch(e.target.value)}
                    placeholder="Buscar personagem..."
                    className="w-full rounded-lg border border-white/10 bg-[#090B10] py-1.5 pl-8 pr-3 text-sm sm:text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds(new Set(ninjas.filter((n) => n.hasVideo).map((n) => n.id)))
                    }
                    className="rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-white/20 hover:text-white cursor-pointer tabular-nums"
                  >
                    Com vídeo ({videoNinjaCount})
                  </button>
                  <button
                    type="button"
                    disabled={selectedIds.size === 0}
                    onClick={() => setSelectedIds(new Set())}
                    className="rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    Limpar
                  </button>
                </div>
              </div>

              {/* Options strip */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-white/[0.06] px-4 py-2.5 text-xs text-slate-300">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={customIncludeParticles}
                    onChange={(e) => setCustomIncludeParticles(e.target.checked)}
                    className="accent-orange-500"
                  />
                  <span>Partículas e auras</span>
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
                  <span>Áudios e vozes</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={customIncludeNameArt}
                    onChange={(e) => setCustomIncludeNameArt(e.target.checked)}
                    className="accent-orange-500"
                  />
                  <span>Artes de nome</span>
                </label>
              </div>

              {/* Selectable list */}
              <div className="max-h-72 overflow-y-auto p-3">
                {filteredCustomNinjas.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    Nenhum personagem encontrado para &ldquo;{customSearch}&rdquo;.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredCustomNinjas.map((n) => {
                      const checked = selectedIds.has(n.id);
                      return (
                        <label
                          key={n.id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer transition-colors ${
                            checked
                              ? 'border-orange-500/50 bg-orange-500/10 text-slate-100'
                              : 'border-white/[0.05] bg-[#090B10] text-slate-300 hover:border-white/15'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCustomNinja(n.id)}
                              className="accent-orange-500 shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{n.name || n.id}</div>
                              <div className="truncate font-mono text-[10px] text-slate-500">
                                {n.id}
                                {n.hasVideo ? ' · Vídeo' : ''}
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3">
                <span className="text-xs text-slate-400">
                  {customStatus ||
                    `${selectedIds.size} ${selectedIds.size === 1 ? 'personagem selecionado' : 'personagens selecionados'}`}
                </span>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={selectedIds.size === 0 || Boolean(exportingDirectKey)}
                    onClick={() => void handleExportDirectForCustom('sh')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Smartphone className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
                    <span>{exportingDirectKey === 'custom-sh' ? 'Gerando...' : 'Android .sh'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedIds.size === 0 || Boolean(exportingDirectKey)}
                    onClick={() => void handleExportDirectForCustom('ps1')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Terminal className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span>{exportingDirectKey === 'custom-ps1' ? 'Gerando...' : 'Windows .ps1'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedIds.size === 0 || preparingCustom || isJobRunning}
                    onClick={() => void handleDownloadCustomBackup()}
                    className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {preparingCustom
                        ? 'Preparando...'
                        : `Navegador (${selectedIds.size})`}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
