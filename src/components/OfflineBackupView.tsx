import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clapperboard,
  Download,
  FolderOpen,
  HardDrive,
  Layers,
  Music,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  WifiOff,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import {
  mountBackupZipFiles,
  setStrictOfflineMode,
  unmountBackupZip,
  useOfflineZipState,
} from '../utils/offlineZipStore';
import { clearMediaProfileCache, isStaticHostingMode } from '../utils/remoteClient';

interface BackupModulePlanItem {
  id: string;
  module: 'base' | 'videos' | 'audios' | 'particles' | 'sprites' | 'assets';
  part: number;
  totalParts: number;
  label: string;
  description: string;
  filename: string;
  fileCount: number;
  estimatedBytes: number;
  recommended: boolean;
}

interface BackupPlanResponse {
  origin: string;
  gameTitle: string;
  totalCatalogNinjas: number;
  mp4NinjaCount: number;
  modules: BackupModulePlanItem[];
  completeFileCount: number;
  completeEstimatedBytes: number;
}

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

  const [mounting, setMounting] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Server backup plan state
  const [plan, setPlan] = useState<BackupPlanResponse | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(() => new Set());
  const [downloadTab, setDownloadTab] = useState<'modular' | 'presets' | 'custom'>('modular');

  // Custom ninja selection backup state
  const [customSearch, setCustomSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [customIncludeParticles, setCustomIncludeParticles] = useState(true);
  const [customIncludeVideos, setCustomIncludeVideos] = useState(true);
  const [customIncludeAudio, setCustomIncludeAudio] = useState(true);
  const [customIncludeNameArt, setCustomIncludeNameArt] = useState(true);
  const [preparingCustom, setPreparingCustom] = useState(false);
  const [customStatus, setCustomStatus] = useState<string | null>(null);

  const fetchBackupPlan = useCallback(async () => {
    if (isStaticHostingMode()) {
      setPlanError(
        'A geração de backup em streaming requer o servidor local/Node ativo. Em hospedagem estática, use a seção acima para abrir backups .zip já salvos no dispositivo.'
      );
      return;
    }
    setLoadingPlan(true);
    setPlanError(null);
    try {
      const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
      const resp = await fetch(`/api/backup/plan?url=${encodeURIComponent(target)}`);
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(
          'Servidor de geração de backup indisponível neste ambiente. Você ainda pode carregar qualquer arquivo .zip local acima.'
        );
      }
      const data = (await resp.json()) as BackupPlanResponse & { error?: string };
      if (!resp.ok) {
        throw new Error(data.error || 'Não foi possível calcular o plano de backup.');
      }
      setPlan(data);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Erro ao carregar plano de backup.');
    } finally {
      setLoadingPlan(false);
    }
  }, [sourceUrl]);

  useEffect(() => {
    if (!offlineZip.active) {
      void fetchBackupPlan();
    }
  }, [fetchBackupPlan, offlineZip.active]);

  const handleMountFiles = async (fileList: FileList | File[] | null, append: boolean) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) =>
      f.name.toLowerCase().endsWith('.zip') || f.type.includes('zip') || f.size > 22
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

  const handleModuleDownload = (mod: BackupModulePlanItem) => {
    const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
    const url = `/api/backup/download?url=${encodeURIComponent(target)}&module=${encodeURIComponent(mod.module)}&part=${mod.part}`;
    triggerNativeDownload(url, mod.filename);
    setDownloadedIds((prev) => new Set(prev).add(mod.id));
  };

  const handlePresetDownload = (moduleKey: 'mp4_ninjas' | 'complete', filename: string) => {
    const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
    const url = `/api/backup/download?url=${encodeURIComponent(target)}&module=${encodeURIComponent(moduleKey)}`;
    triggerNativeDownload(url, filename);
    setDownloadedIds((prev) => new Set(prev).add(moduleKey));
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
    if (selectedIds.size === 0 || preparingCustom) return;
    setPreparingCustom(true);
    setCustomStatus('Preparando stream do backup autocontido...');
    try {
      const target = sourceUrl.trim() || 'https://naruto.jotagame.com/';
      const resp = await fetch('/api/backup/custom-prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: target,
          ninjaIds: Array.from(selectedIds),
          includeParticles: customIncludeParticles,
          includeVideos: customIncludeVideos,
          includeAudio: customIncludeAudio,
          includeNameArt: customIncludeNameArt,
        }),
      });
      const data = (await resp.json()) as {
        downloadUrl?: string;
        filename?: string;
        ninjaCount?: number;
        error?: string;
      };
      if (!resp.ok || !data.downloadUrl) {
        throw new Error(data.error || 'Falha ao preparar backup personalizado.');
      }
      setCustomStatus(
        `Download iniciado (${data.filename})! Acompanhe o progresso na barra de downloads do navegador/Android.`
      );
      triggerNativeDownload(data.downloadUrl, data.filename);
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

      {/* SECTION 2: GENERATE & DOWNLOAD FULL / MODULAR / CUSTOM OFFLINE BACKUPS */}
      <section className="rounded-lg border border-slate-800 bg-[#131A26] p-4 sm:p-6 space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="font-display text-lg sm:text-xl font-bold text-slate-50">
              Baixar Backup Completo para seu Android (.ZIP)
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 max-w-3xl leading-relaxed">
              Os arquivos são gerados em <strong>streaming direto (formato STORE sem compressão extra)</strong> para o gerenciador de downloads do Android — sem travar a memória do navegador e prontos para leitura instantânea acima.
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
            Modular para Android (Recomendado)
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
            Pacotes Únicos (MP4 / Tudo)
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
            className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200"
          >
            {planError}
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
                      Dividido em partes seguras (~150–300 MB) para não falhar no celular. Baixe as partes desejadas e depois selecione todas juntas na área acima.
                    </span>
                  </div>
                  <span className="font-mono text-slate-400 tabular-nums shrink-0">
                    Total completo: {formatSize(plan.completeEstimatedBytes)} ({plan.completeFileCount.toLocaleString('pt-BR')} arquivos)
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {recommendedModules.map((mod) => {
                    const isDone = downloadedIds.has(mod.id);
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
                        <div className="space-y-1.5">
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
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-3">
                          <span className="truncate font-mono text-[11px] text-slate-500 tabular-nums">
                            {mod.filename} · {mod.fileCount.toLocaleString('pt-BR')} arq.
                          </span>
                          <button
                            type="button"
                            onClick={() => handleModuleDownload(mod)}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
                              isDone
                                ? 'border border-emerald-500/40 bg-emerald-950/60 text-emerald-200 hover:bg-emerald-950'
                                : 'bg-orange-600 text-white hover:bg-orange-500'
                            }`}
                          >
                            {isDone ? (
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <Download className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <span>{isDone ? 'Baixar Novamente' : 'Baixar Parte (.ZIP)'}</span>
                          </button>
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
                                onClick={() => handleModuleDownload(mod)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#131A26] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-orange-500/60 cursor-pointer shrink-0"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>{isDone ? 'Baixar Novamente' : 'Baixar Opcional'}</span>
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
                  Gera um único arquivo <code className="font-mono text-slate-200">.zip</code> pronto para rodar 100% offline com todos os personagens que possuem vídeo de ultimate/apresentação — incluindo catálogo, esqueletos, folhas de sprites exatas, partículas <code className="font-mono text-slate-200">noe_*</code>, auras Susano’o, MP4s e vozes/áudios MP3.
                </p>
              </div>
              <button
                type="button"
                disabled={!plan}
                onClick={() =>
                  handlePresetDownload(
                    'mp4_ninjas',
                    `shinobi_backup_${plan?.mp4NinjaCount || 139}_ninjas_com_mp4.zip`
                  )
                }
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>Baixar Pacote dos {plan?.mp4NinjaCount || 139} Ninjas com MP4 (.ZIP)</span>
              </button>
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
                  Junta Base + todos os Vídeos MP4 + todos os Áudios MP3 + todas as Partículas + todas as Folhas de Sprites ({plan ? formatSize(plan.completeEstimatedBytes) : '~3,8 GB'}) em um único arquivo ZIP64. Ideal para Wi-Fi estável ou PC; no celular recomendamos a aba <strong>Modular</strong>.
                </p>
              </div>
              <button
                type="button"
                disabled={!plan}
                onClick={() => handlePresetDownload('complete', 'shinobi_backup_completo_tudo.zip')}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>
                  Baixar Tudo em 1 ZIP ({plan ? formatSize(plan.completeEstimatedBytes) : '...'})
                </span>
              </button>
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
                Gera 1 arquivo <code className="font-mono text-slate-200">.zip</code> autocontido com os sprites, partículas, vídeos e vozes exatos dos ninjas selecionados — perfeito para testar rápido no celular!
              </p>
              <button
                type="button"
                disabled={selectedIds.size === 0 || preparingCustom}
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
