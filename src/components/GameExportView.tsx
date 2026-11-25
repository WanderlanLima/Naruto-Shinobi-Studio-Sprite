import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderGit2,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import type { ParsedEffectAsset } from '../utils/completeCharacterExporter';
import {
  buildGameExportForNinja,
  downloadSplitGameExportZips,
  mergeGameRootIndex,
  type GameExportFile,
  type GameExportOptions,
  type GameIndexCharacterEntry,
  type GameRootIndex,
} from '../utils/gameExporter';
import {
  downloadTermuxGameExportScript,
  formatGameBytes,
} from '../utils/gameExportTermuxScript';
import {
  createGitHubUploadSession,
  fetchExistingRepoJson,
  normalizeGitHubBranch,
  normalizeGitHubDestFolder,
  parseGitHubRepoSlug,
  testGitHubConnection,
  uploadFilesBatchToGitHub,
  type GitHubCommitRecord,
  type GitHubConnectionTestResult,
  type GitHubFileTransferRecord,
} from '../utils/githubGitDataUploader';
import {
  markManyNinjasExported,
  useNinjaCollections,
} from '../utils/ninjaCollectionsStore';

interface GameExportViewProps {
  ninjas: NinjaEntry[];
  isOfflineMode: boolean;
}

const PREFS_STORAGE_KEY = 'shinobi_game_export_prefs_v1';
const TOKEN_STORAGE_KEY = 'shinobi_game_export_token_v1';
const RESUME_STORAGE_KEY = 'shinobi_game_export_resume_v1';

interface SavedGameExportPrefs {
  repo: string;
  branch: string;
  destFolder: string;
  persistTokenOnDevice: boolean;
  includeEffects: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includeGifs: boolean;
  fps: number;
}

interface SavedResumeState {
  selectedIds: string[];
  completedIds: string[];
  indexEntries: GameIndexCharacterEntry[];
  repo: string;
  branch: string;
  destFolder: string;
  updatedAt: number;
}

function loadPrefs(): SavedGameExportPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SavedGameExportPrefs>;
      return {
        repo: typeof p.repo === 'string' ? p.repo : '',
        branch: typeof p.branch === 'string' && p.branch.trim() ? p.branch : 'main',
        destFolder: typeof p.destFolder === 'string' ? p.destFolder : 'assets/shinobi',
        persistTokenOnDevice: Boolean(p.persistTokenOnDevice),
        includeEffects: typeof p.includeEffects === 'boolean' ? p.includeEffects : true,
        includeAudio: typeof p.includeAudio === 'boolean' ? p.includeAudio : true,
        includeVideos: typeof p.includeVideos === 'boolean' ? p.includeVideos : false,
        includeGifs: typeof p.includeGifs === 'boolean' ? p.includeGifs : false,
        fps: typeof p.fps === 'number' && p.fps >= 8 && p.fps <= 60 ? p.fps : 24,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    repo: '',
    branch: 'main',
    destFolder: 'assets/shinobi',
    persistTokenOnDevice: false,
    includeEffects: true,
    includeAudio: true,
    includeVideos: false,
    includeGifs: false,
    fps: 24,
  };
}

function loadSavedToken(persistEnabled: boolean): string {
  if (!persistEnabled) return '';
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function loadResumeState(): SavedResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedResumeState;
    if (
      Array.isArray(parsed.selectedIds) &&
      Array.isArray(parsed.completedIds) &&
      parsed.selectedIds.length > parsed.completedIds.length
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

type NinjaFilterTab = 'character' | 'favorites' | 'selected' | 'all';

interface LocalZipSummary {
  filename: string;
  fileCount: number;
  bytes: number;
}

export function GameExportView({ ninjas, isOfflineMode }: GameExportViewProps) {
  const collections = useNinjaCollections();
  const initialPrefs = useRef<SavedGameExportPrefs | null>(null);
  if (!initialPrefs.current) {
    initialPrefs.current = loadPrefs();
  }

  // Ninja selection state
  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<NinjaFilterTab>('character');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const saved = loadResumeState();
    return saved ? new Set(saved.selectedIds) : new Set();
  });

  // Export options (defaults: effects YES, audio YES, videos NO, gifs NO)
  const [includeEffects, setIncludeEffects] = useState(initialPrefs.current.includeEffects);
  const [includeAudio, setIncludeAudio] = useState(initialPrefs.current.includeAudio);
  const [includeVideos, setIncludeVideos] = useState(initialPrefs.current.includeVideos);
  const [includeGifs, setIncludeGifs] = useState(initialPrefs.current.includeGifs);
  const [fps, setFps] = useState(initialPrefs.current.fps);

  // GitHub fields (token strictly in memory by default, or localStorage only if user checks the box)
  const [repo, setRepo] = useState(initialPrefs.current.repo);
  const [branch, setBranch] = useState(initialPrefs.current.branch);
  const [destFolder, setDestFolder] = useState(initialPrefs.current.destFolder);
  const [persistTokenOnDevice, setPersistTokenOnDevice] = useState(
    initialPrefs.current.persistTokenOnDevice
  );
  const [token, setToken] = useState(() =>
    loadSavedToken(initialPrefs.current!.persistTokenOnDevice)
  );
  const [showToken, setShowToken] = useState(false);

  // Connection test
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<GitHubConnectionTestResult | null>(null);

  // Execution & progress state
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<'github' | 'zip' | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [runError, setRunError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fileRecords, setFileRecords] = useState<GitHubFileTransferRecord[]>([]);
  const [commits, setCommits] = useState<GitHubCommitRecord[]>([]);
  const [downloadedZips, setDownloadedZips] = useState<LocalZipSummary[]>([]);
  const [resumeState, setResumeState] = useState<SavedResumeState | null>(() => loadResumeState());

  // Termux output state
  const [termuxResult, setTermuxResult] = useState<{
    scriptFilename: string;
    command: string;
    count: number;
  } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // Persist non-sensitive preferences
  useEffect(() => {
    try {
      const payload: SavedGameExportPrefs = {
        repo,
        branch,
        destFolder,
        persistTokenOnDevice,
        includeEffects,
        includeAudio,
        includeVideos,
        includeGifs,
        fps,
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  }, [
    repo,
    branch,
    destFolder,
    persistTokenOnDevice,
    includeEffects,
    includeAudio,
    includeVideos,
    includeGifs,
    fps,
  ]);

  // Persist or wipe token based on explicit user choice (never logged)
  useEffect(() => {
    try {
      if (persistTokenOnDevice && token.trim()) {
        localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
      } else {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, [persistTokenOnDevice, token]);

  const saveResumeSnapshot = useCallback((state: SavedResumeState | null) => {
    setResumeState(state);
    try {
      if (state) {
        localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(state));
      } else {
        localStorage.removeItem(RESUME_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, []);

  const filteredNinjas = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ninjas.filter((n) => {
      if (filterTab === 'character' && n.kind && n.kind !== 'character') return false;
      if (filterTab === 'favorites' && !collections.favorites.includes(n.id)) return false;
      if (filterTab === 'selected' && !selectedIds.has(n.id)) return false;
      if (!q) return true;
      return (
        n.id.toLowerCase().includes(q) ||
        (n.name || '').toLowerCase().includes(q) ||
        (n.code || '').toLowerCase().includes(q)
      );
    });
  }, [ninjas, search, filterTab, collections.favorites, selectedIds]);

  const selectedNinjas = useMemo(
    () => ninjas.filter((n) => selectedIds.has(n.id)),
    [ninjas, selectedIds]
  );

  const toggleNinja = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const n of filteredNinjas) next.add(n.id);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleClearToken = () => {
    setToken('');
    setConnResult(null);
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setConnResult(null);
    try {
      const res = await testGitHubConnection({
        repo,
        branch: normalizeGitHubBranch(branch),
        destFolder: normalizeGitHubDestFolder(destFolder),
        token,
      });
      setConnResult(res);
    } finally {
      setTestingConn(false);
    }
  };

  const exportOptions: GameExportOptions = {
    includeEffects,
    includeAudio,
    includeVideos,
    includeGifs,
    fps,
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRunGitHubUpload = async (isResume: boolean) => {
    const parsedRepo = parseGitHubRepoSlug(repo);
    if (!parsedRepo) {
      setRunError('Informe o repositório no formato usuario/repositorio.');
      return;
    }
    if (!token.trim()) {
      setRunError('Informe o token do GitHub ou use a opção "Baixar ZIPs (≤ 20 MB)".');
      return;
    }

    const queueIds =
      isResume && resumeState
        ? resumeState.selectedIds
        : selectedNinjas.map((n) => n.id);
    const completedSet = new Set<string>(
      isResume && resumeState ? resumeState.completedIds : []
    );
    const accumulatedIndexEntries: GameIndexCharacterEntry[] =
      isResume && resumeState ? [...resumeState.indexEntries] : [];

    const ninjaById = new Map(ninjas.map((n) => [n.id, n]));
    const pendingNinjas = queueIds
      .filter((id) => !completedSet.has(id))
      .map((id) => ninjaById.get(id))
      .filter((n): n is NinjaEntry => Boolean(n));

    if (pendingNinjas.length === 0) {
      setRunError('Selecione ao menos um ninja para exportar.');
      return;
    }

    const cleanBranch = normalizeGitHubBranch(branch);
    const cleanFolder = normalizeGitHubDestFolder(destFolder);

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRunMode('github');
    setRunError(null);
    setDownloadedZips([]);
    if (!isResume) {
      setFileRecords([]);
      setCommits([]);
      setWarnings([]);
    }
    setProgressPercent(2);
    setStatusMessage(`Conectando a ${parsedRepo.fullName} (${cleanBranch})...`);

    const effectCache = new Map<string, Promise<ParsedEffectAsset | null>>();
    const totalCount = queueIds.length;

    try {
      const session = await createGitHubUploadSession(
        {
          repo: parsedRepo.fullName,
          branch: cleanBranch,
          destFolder: cleanFolder,
          token: token.trim(),
        },
        controller.signal
      );

      // Load existing index.json from repository so incremental exports keep previous ninjas
      const existingRepoIndex = await fetchExistingRepoJson<GameRootIndex>(
        session,
        'index.json',
        controller.signal
      );

      for (let i = 0; i < pendingNinjas.length; i++) {
        if (controller.signal.aborted) {
          throw new DOMException('Envio cancelado.', 'AbortError');
        }
        const ninja = pendingNinjas[i];
        const doneBefore = completedSet.size;
        const basePct = Math.round((doneBefore / totalCount) * 94);
        setProgressPercent(Math.max(3, basePct));

        const built = await buildGameExportForNinja({
          ninja,
          options: exportOptions,
          effectCache,
          signal: controller.signal,
          onStep: (msg) => setStatusMessage(`[${doneBefore + 1}/${totalCount}] ${msg}`),
        });

        if (built.skippedWarnings.length > 0) {
          setWarnings((prev) => [...prev, ...built.skippedWarnings]);
        }

        // Update index.json with all characters exported so far
        const existingIdxPos = accumulatedIndexEntries.findIndex(
          (e) => e.id === built.indexEntry.id
        );
        if (existingIdxPos >= 0) accumulatedIndexEntries[existingIdxPos] = built.indexEntry;
        else accumulatedIndexEntries.push(built.indexEntry);

        const mergedIndex = mergeGameRootIndex(existingRepoIndex, accumulatedIndexEntries);
        const indexBytes = new TextEncoder().encode(JSON.stringify(mergedIndex, null, 2));

        const filesToCommit: GameExportFile[] = [
          ...built.files,
          { path: 'index.json', bytes: indexBytes },
        ];

        const uploadRes = await uploadFilesBatchToGitHub(
          session,
          filesToCommit,
          `assets(shinobi): exportar ${built.manifest.name} (${built.characterIdSlug})`,
          {
            onStatus: (msg) => setStatusMessage(`[${doneBefore + 1}/${totalCount}] ${msg}`),
            onFileDone: (rec) => setFileRecords((prev) => [...prev, rec]),
            onCommitCreated: (commit) => setCommits((prev) => [...prev, commit]),
          },
          controller.signal
        );

        const hasFailed = uploadRes.records.some((r) => r.status === 'failed');
        if (!hasFailed) {
          completedSet.add(ninja.id);
          markManyNinjasExported([ninja.id], 'browser');
        }

        const remainingAfter = queueIds.length - completedSet.size;
        if (remainingAfter > 0) {
          saveResumeSnapshot({
            selectedIds: queueIds,
            completedIds: Array.from(completedSet),
            indexEntries: accumulatedIndexEntries,
            repo: parsedRepo.fullName,
            branch: cleanBranch,
            destFolder: cleanFolder,
            updatedAt: Date.now(),
          });
        } else {
          saveResumeSnapshot(null);
        }

        setProgressPercent(Math.round((completedSet.size / totalCount) * 100));
      }

      setStatusMessage(
        `Concluído: ${completedSet.size} ninja(s) sincronizado(s) com ${parsedRepo.fullName} (${cleanBranch}).`
      );
      setProgressPercent(100);
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const msg = isAbort
        ? 'Envio pausado. Clique em "Continuar" para retomar sem reenviar arquivos já salvos.'
        : err instanceof Error
        ? err.message
        : 'Falha de conexão durante o envio ao GitHub.';
      setRunError(msg);
      if (completedSet.size < queueIds.length) {
        saveResumeSnapshot({
          selectedIds: queueIds,
          completedIds: Array.from(completedSet),
          indexEntries: accumulatedIndexEntries,
          repo: parsedRepo.fullName,
          branch: cleanBranch,
          destFolder: cleanFolder,
          updatedAt: Date.now(),
        });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleDownloadSplitZips = async () => {
    if (selectedNinjas.length === 0) {
      setRunError('Selecione ao menos um ninja para baixar.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRunMode('zip');
    setRunError(null);
    setWarnings([]);
    setFileRecords([]);
    setCommits([]);
    setDownloadedZips([]);
    setProgressPercent(2);

    const effectCache = new Map<string, Promise<ParsedEffectAsset | null>>();
    const allFiles: GameExportFile[] = [];
    const seenPaths = new Set<string>();
    const indexEntries: GameIndexCharacterEntry[] = [];

    try {
      for (let i = 0; i < selectedNinjas.length; i++) {
        if (controller.signal.aborted) {
          throw new DOMException('Exportação cancelada.', 'AbortError');
        }
        const ninja = selectedNinjas[i];
        setProgressPercent(Math.max(4, Math.round((i / selectedNinjas.length) * 86)));

        const built = await buildGameExportForNinja({
          ninja,
          options: exportOptions,
          effectCache,
          signal: controller.signal,
          onStep: (msg) => setStatusMessage(`[${i + 1}/${selectedNinjas.length}] ${msg}`),
        });

        if (built.skippedWarnings.length > 0) {
          setWarnings((prev) => [...prev, ...built.skippedWarnings]);
        }

        for (const f of built.files) {
          if (seenPaths.has(f.path)) continue;
          seenPaths.add(f.path);
          allFiles.push(f);
          setFileRecords((prev) => [
            ...prev,
            {
              path: f.path,
              repoPath: f.path,
              size: f.bytes.byteLength,
              status: 'uploaded',
            },
          ]);
        }
        indexEntries.push(built.indexEntry);
      }

      const rootIndex = mergeGameRootIndex(null, indexEntries);
      const indexBytes = new TextEncoder().encode(JSON.stringify(rootIndex, null, 2));
      allFiles.push({ path: 'index.json', bytes: indexBytes });
      setFileRecords((prev) => [
        ...prev,
        {
          path: 'index.json',
          repoPath: 'index.json',
          size: indexBytes.byteLength,
          status: 'uploaded',
        },
      ]);

      setProgressPercent(90);
      const baseName =
        selectedNinjas.length === 1
          ? `shinobi_phaser_${selectedNinjas[0].id}`
          : `shinobi_phaser_${selectedNinjas.length}_ninjas`;

      const zips = await downloadSplitGameExportZips(
        allFiles,
        baseName,
        (msg) => setStatusMessage(msg),
        controller.signal
      );

      setDownloadedZips(zips);
      markManyNinjasExported(
        selectedNinjas.map((n) => n.id),
        'browser'
      );
      setProgressPercent(100);
      setStatusMessage(
        `Download concluído: ${zips.length} arquivo(s) ZIP (máx. 20 MB cada) com ${allFiles.length} arquivos.`
      );
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      setRunError(
        isAbort
          ? 'Exportação cancelada.'
          : err instanceof Error
          ? err.message
          : 'Erro ao gerar os arquivos ZIP.'
      );
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleGenerateTermux = () => {
    if (selectedNinjas.length === 0) {
      setRunError('Selecione ao menos um ninja para gerar o script Termux.');
      return;
    }
    setRunError(null);
    const res = downloadTermuxGameExportScript({
      ninjas: selectedNinjas,
      options: exportOptions,
      githubRepo: repo,
      githubBranch: branch,
      githubDestFolder: destFolder,
    });
    setTermuxResult(res);
    setCopiedCmd(false);
  };

  const handleCopyTermuxCmd = () => {
    if (!termuxResult) return;
    navigator.clipboard?.writeText(termuxResult.command);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2200);
  };

  const stats = useMemo(() => {
    let uploadedCount = 0;
    let uploadedBytes = 0;
    let skippedCount = 0;
    let failedCount = 0;
    for (const r of fileRecords) {
      if (r.status === 'uploaded') {
        uploadedCount++;
        uploadedBytes += r.size;
      } else if (r.status === 'skipped') {
        skippedCount++;
      } else {
        failedCount++;
      }
    }
    return { uploadedCount, uploadedBytes, skippedCount, failedCount };
  }, [fileRecords]);

  const hasTokenAndRepo = Boolean(token.trim() && parseGitHubRepoSlug(repo));
  const pendingResumeCount = resumeState
    ? Math.max(0, resumeState.selectedIds.length - resumeState.completedIds.length)
    : 0;

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-slate-50">
            Exportar para o jogo (Phaser 3)
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Exporta apenas animações essenciais de gameplay (idle, mover, pular/cair, ataque, jutsus, ultimate, dano, morte e vitória) em spritesheets 1:1 (máx. 2048×2048 px) com pivô nos pés, posição da mão/arma por frame e envio direto ao GitHub ou ZIPs de até 20 MB.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400 tabular-nums">
          <span>{isOfflineMode ? 'Fonte: Backup Offline' : 'Fonte: Online'}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-slate-200">{selectedIds.size} selecionado(s)</span>
        </div>
      </div>

      {/* Resumable Session Banner */}
      {resumeState && pendingResumeCount > 0 && !running && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-orange-500/35 bg-orange-950/20 px-4 py-3 text-xs text-orange-100">
          <div className="space-y-0.5 min-w-0">
            <div className="font-semibold text-slate-50">
              Envio anterior interrompido · {resumeState.completedIds.length}/{resumeState.selectedIds.length} ninja(s) concluído(s)
            </div>
            <div className="text-slate-300 tabular-nums">
              Destino: <span className="font-mono">{resumeState.repo}</span> ({resumeState.branch}) · Restam {pendingResumeCount} ninja(s). Arquivos já no repositório serão pulados automaticamente.
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleRunGitHubUpload(true)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Continuar ({pendingResumeCount})</span>
            </button>
            <button
              type="button"
              onClick={() => saveResumeSnapshot(null)}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/15 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-300 hover:text-white cursor-pointer whitespace-nowrap"
            >
              Descartar
            </button>
          </div>
        </div>
      )}

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
        {/* Left Column: Multi-select Ninja Picker */}
        <section className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#11141C] overflow-hidden flex flex-col">
          <div className="border-b border-white/[0.07] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm font-semibold text-slate-100">
                1. Selecionar ninjas
              </h2>
              <span className="text-xs text-slate-400 tabular-nums">
                {selectedIds.size} / {ninjas.length}
              </span>
            </div>

            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, ID ou código..."
                aria-label="Buscar ninjas para exportar"
                className="w-full min-h-[42px] rounded-lg border border-white/10 bg-[#090B10] py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="tablist"
                aria-label="Filtrar lista de ninjas"
                className="inline-flex items-center rounded-lg border border-white/[0.08] bg-[#090B10] p-0.5 text-[11px]"
              >
                {(
                  [
                    { id: 'character', label: 'Ninjas' },
                    { id: 'favorites', label: 'Favoritos' },
                    { id: 'selected', label: `Marcados (${selectedIds.size})` },
                    { id: 'all', label: 'Todos' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={filterTab === tab.id}
                    onClick={() => setFilterTab(tab.id)}
                    className={`rounded-md px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      filterTab === tab.id
                        ? 'bg-orange-600 text-white'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAllVisible}
                  disabled={filteredNinjas.length === 0 || running}
                  className="text-orange-400 hover:text-orange-300 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                >
                  Marcar visíveis ({filteredNinjas.length})
                </button>
                <span className="text-slate-600" aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedIds.size === 0 || running}
                  className="text-slate-400 hover:text-slate-200 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                >
                  Limpar
                </button>
              </div>
            </div>
          </div>

          {/* Scrollable Checkbox List */}
          <div className="max-h-[460px] lg:max-h-[600px] overflow-y-auto divide-y divide-white/[0.05]">
            {ninjas.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                Nenhum ninja carregado ainda. Carregue o catálogo online ou conecte seu backup .ZIP offline.
              </div>
            ) : filteredNinjas.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                Nenhum ninja encontrado com esse filtro.
              </div>
            ) : (
              filteredNinjas.slice(0, 350).map((ninja) => {
                const checked = selectedIds.has(ninja.id);
                const doneInResume = resumeState?.completedIds.includes(ninja.id);
                return (
                  <label
                    key={ninja.id}
                    className={`flex min-h-[44px] items-center gap-3 px-4 py-2 text-xs transition-colors cursor-pointer select-none ${
                      checked ? 'bg-orange-500/[0.08]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={running}
                      onChange={() => toggleNinja(ninja.id)}
                      className="h-4 w-4 shrink-0 accent-orange-500 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-100">
                        {ninja.name || ninja.id}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono truncate">
                        <span>{ninja.id}</span>
                        {ninja.code && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>#{ninja.code}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {doneInResume && (
                      <span className="text-[11px] font-medium text-emerald-400 whitespace-nowrap shrink-0">
                        Enviado
                      </span>
                    )}
                  </label>
                );
              })
            )}
            {filteredNinjas.length > 350 && (
              <div className="px-4 py-2.5 text-center text-[11px] text-slate-400">
                Exibindo 350 de {filteredNinjas.length}. Use a busca para encontrar outros ninjas.
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Options, GitHub Config, Actions, Progress & File Table */}
        <div className="lg:col-span-7 space-y-5">
          {/* Options Panel */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-semibold text-slate-100">
                2. Conteúdo da exportação
              </h2>
              <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                <span>FPS</span>
                <select
                  value={fps}
                  disabled={running}
                  onChange={(e) => setFps(Number(e.target.value))}
                  className="rounded-md border border-white/10 bg-[#090B10] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
                >
                  <option value={15}>15</option>
                  <option value={18}>18</option>
                  <option value={24}>24</option>
                  <option value={30}>30</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 text-xs">
              <label className="flex min-h-[44px] items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#090B10] p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeEffects}
                  disabled={running}
                  onChange={(e) => setIncludeEffects(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500"
                />
                <span>
                  <span className="font-medium text-slate-100">Incluir efeitos / partículas</span>
                  <span className="block text-[11px] text-slate-400">
                    Somente efeitos usados nas animações exportadas (effects/)
                  </span>
                </span>
              </label>

              <label className="flex min-h-[44px] items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#090B10] p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeAudio}
                  disabled={running}
                  onChange={(e) => setIncludeAudio(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500"
                />
                <span>
                  <span className="font-medium text-slate-100">Incluir sons MP3</span>
                  <span className="block text-[11px] text-slate-400">
                    Somente áudios disparados pelas animações exportadas (audio/)
                  </span>
                </span>
              </label>

              <label className="flex min-h-[44px] items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#090B10] p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeVideos}
                  disabled={running}
                  onChange={(e) => setIncludeVideos(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500"
                />
                <span>
                  <span className="font-medium text-slate-100">Incluir vídeos MP4</span>
                  <span className="block text-[11px] text-slate-400">
                    Padrão: desligado (arquivos mais pesados, limite 20 MB)
                  </span>
                </span>
              </label>

              <label className="flex min-h-[44px] items-start gap-2.5 rounded-lg border border-white/[0.06] bg-[#090B10] p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeGifs}
                  disabled={running}
                  onChange={(e) => setIncludeGifs(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500"
                />
                <span>
                  <span className="font-medium text-slate-100">Incluir GIFs</span>
                  <span className="block text-[11px] text-slate-400">
                    Padrão: desligado (Phaser 3 usa apenas PNG + JSON)
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* GitHub Destination Panel */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-orange-400" aria-hidden="true" />
                <h2 className="font-display text-sm font-semibold text-slate-100">
                  3. Envio direto para o GitHub (opcional)
                </h2>
              </div>
              <button
                type="button"
                disabled={testingConn || running || !repo.trim() || !token.trim()}
                onClick={() => void handleTestConnection()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 disabled:opacity-40 cursor-pointer whitespace-nowrap"
              >
                {testingConn ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>Testar conexão</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1 sm:col-span-2">
                <span className="block text-xs font-medium text-slate-300">
                  Usuário / Repositório
                </span>
                <input
                  type="text"
                  value={repo}
                  disabled={running}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="seu-usuario/meu-jogo-naruto"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full min-h-[42px] rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-300">Branch</span>
                <input
                  type="text"
                  value={branch}
                  disabled={running}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full min-h-[42px] rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-slate-300">
                  Pasta de destino no repositório
                </span>
                <input
                  type="text"
                  value={destFolder}
                  disabled={running}
                  onChange={(e) => setDestFolder(e.target.value)}
                  placeholder="assets/shinobi (ou vazio para raiz)"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full min-h-[42px] rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                />
              </label>

              <div className="space-y-1">
                <span className="block text-xs font-medium text-slate-300">
                  Token Fine-Grained (Contents: Read &amp; write)
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <KeyRound
                      className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                      aria-hidden="true"
                    />
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      disabled={running}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="github_pat_..."
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Token fine-grained do GitHub"
                      className="w-full min-h-[42px] rounded-lg border border-white/10 bg-[#090B10] py-2 pl-9 pr-9 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-100 cursor-pointer"
                    >
                      {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  {token && (
                    <button
                      type="button"
                      onClick={handleClearToken}
                      disabled={running}
                      aria-label="Limpar token"
                      className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-lg border border-white/10 bg-[#090B10] text-slate-400 hover:border-red-500/40 hover:text-red-300 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={persistTokenOnDevice}
                  onChange={(e) => setPersistTokenOnDevice(e.target.checked)}
                  className="h-3.5 w-3.5 accent-orange-500"
                />
                <span>Salvar token apenas neste aparelho (localStorage)</span>
              </label>
              <span>Nunca vai para código, scripts nem logs.</span>
            </div>

            {connResult && (
              <div
                role="status"
                className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
                  connResult.ok
                    ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
                    : 'border-red-500/30 bg-red-950/20 text-red-200'
                }`}
              >
                {connResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                )}
                <span>{connResult.message}</span>
              </div>
            )}

            <details className="border-t border-white/[0.06] pt-3 text-xs text-slate-400">
              <summary className="cursor-pointer font-medium text-slate-300 hover:text-slate-100 select-none">
                Como criar um token Fine-Grained seguro em 30 segundos
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-slate-400">
                <li>
                  No GitHub, acesse <span className="text-slate-200">Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</span>.
                </li>
                <li>
                  Em <span className="text-slate-200">Repository access</span>, marque <span className="text-slate-200">Only select repositories</span> e escolha apenas o seu repositório privado do jogo.
                </li>
                <li>
                  Em <span className="text-slate-200">Repository permissions → Contents</span>, selecione <span className="text-slate-200">Read and write</span> (deixe todo o resto sem permissão).
                </li>
                <li>
                  Clique em <span className="text-slate-200">Generate token</span> e cole acima.
                </li>
              </ol>
            </details>
          </section>

          {/* Action Buttons */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              {!running ? (
                <>
                  {hasTokenAndRepo ? (
                    <button
                      type="button"
                      disabled={selectedNinjas.length === 0}
                      onClick={() => void handleRunGitHubUpload(false)}
                      className="inline-flex min-h-[44px] flex-1 sm:flex-none items-center justify-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Upload className="h-4 w-4" aria-hidden="true" />
                      <span>Enviar para o GitHub ({selectedNinjas.length})</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={selectedNinjas.length === 0}
                      onClick={() => void handleDownloadSplitZips()}
                      className="inline-flex min-h-[44px] flex-1 sm:flex-none items-center justify-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      <span>Baixar ZIPs ≤ 20 MB ({selectedNinjas.length})</span>
                    </button>
                  )}

                  {hasTokenAndRepo && (
                    <button
                      type="button"
                      disabled={selectedNinjas.length === 0}
                      onClick={() => void handleDownloadSplitZips()}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/15 bg-[#090B10] px-4 py-2.5 text-xs font-medium text-slate-200 hover:border-white/30 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Baixar ZIPs (≤ 20 MB)</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={selectedNinjas.length === 0}
                    onClick={handleGenerateTermux}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-white/15 bg-[#090B10] px-4 py-2.5 text-xs font-medium text-slate-200 hover:border-white/30 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Script Termux (.sh)</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2.5 text-xs font-semibold text-red-200 hover:bg-red-900/40 cursor-pointer whitespace-nowrap"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Parar ({runMode === 'github' ? 'pode continuar depois' : 'cancelar'})</span>
                </button>
              )}
            </div>

            {!hasTokenAndRepo && (
              <p className="text-[11px] text-slate-400">
                Sem token configurado: o download gera pacotes ZIP divididos em no máximo 20 MB cada, com a mesma estrutura <span className="font-mono text-slate-300">characters/&lt;id&gt;/</span> + <span className="font-mono text-slate-300">index.json</span>.
              </p>
            )}

            {/* Termux Command Box */}
            {termuxResult && (
              <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-950/15 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-emerald-300">
                  <span className="inline-flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Script Termux baixado ({termuxResult.count} ninja(s))</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyTermuxCmd}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 cursor-pointer"
                  >
                    {copiedCmd ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedCmd ? 'Copiado' : 'Copiar comando'}</span>
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-[#090B10] px-3 py-2 font-mono text-[11px] text-slate-200">
                  {termuxResult.command}
                </pre>
                <p className="text-[11px] text-slate-400">
                  No Termux, o script detecta automaticamente seu backup .zip em Downloads, pede o token de forma oculta (se quiser enviar ao GitHub) ou salva em ZIPs de até 20 MB.
                </p>
              </div>
            )}

            {/* Progress Bar */}
            {(running || progressPercent > 0 || statusMessage) && (
              <div className="space-y-2 border-t border-white/[0.06] pt-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-slate-200">
                    {statusMessage || 'Preparando...'}
                  </span>
                  <span className="font-mono tabular-nums text-orange-400 shrink-0">
                    {progressPercent}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full bg-orange-500 transition-all duration-200"
                    style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error Notice */}
            {runError && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-xs text-red-200"
              >
                <div className="flex items-start gap-2 min-w-0">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                  <span>{runError}</span>
                </div>
                {resumeState && pendingResumeCount > 0 && !running && (
                  <button
                    type="button"
                    onClick={() => void handleRunGitHubUpload(true)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Play className="h-3 w-3" aria-hidden="true" />
                    <span>Continuar</span>
                  </button>
                )}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 px-3 py-2 text-[11px] text-amber-200 space-y-0.5">
                {warnings.slice(0, 6).map((w, idx) => (
                  <div key={idx}>{w}</div>
                ))}
                {warnings.length > 6 && <div>+ {warnings.length - 6} aviso(s)</div>}
              </div>
            )}
          </section>

          {/* Summary & Transferred Files Table */}
          {(fileRecords.length > 0 || commits.length > 0 || downloadedZips.length > 0) && (
            <section className="rounded-xl border border-white/[0.08] bg-[#11141C] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
                <h2 className="font-display text-sm font-semibold text-slate-100">
                  Arquivos processados
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-slate-300">
                  <span>
                    {runMode === 'zip' ? 'Gerados' : 'Enviados'}:{' '}
                    <strong className="font-mono text-emerald-400">{stats.uploadedCount}</strong>
                  </span>
                  {stats.skippedCount > 0 && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span>
                        Pulados (iguais):{' '}
                        <strong className="font-mono text-slate-300">{stats.skippedCount}</strong>
                      </span>
                    </>
                  )}
                  {stats.failedCount > 0 && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span>
                        Erros: <strong className="font-mono text-red-400">{stats.failedCount}</strong>
                      </span>
                    </>
                  )}
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span>
                    Total:{' '}
                    <strong className="font-mono text-slate-100">
                      {formatGameBytes(stats.uploadedBytes)}
                    </strong>
                  </span>
                </div>
              </div>

              {commits.length > 0 && (
                <div className="border-b border-white/[0.06] bg-[#0C0F16] px-4 py-2.5 text-xs space-y-1">
                  <div className="font-medium text-slate-300">
                    Commits criados ({commits.length}):
                  </div>
                  {commits.map((c) => (
                    <div
                      key={c.sha}
                      className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums"
                    >
                      <span className="truncate">
                        <span className="font-mono text-emerald-400">{c.sha.slice(0, 7)}</span>{' '}
                        · {c.message}
                      </span>
                      <span className="font-mono shrink-0">
                        {c.fileCount} arq · {formatGameBytes(c.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {downloadedZips.length > 0 && (
                <div className="border-b border-white/[0.06] bg-[#0C0F16] px-4 py-2.5 text-xs space-y-1">
                  <div className="font-medium text-slate-300">
                    ZIPs baixados (≤ 20 MB cada):
                  </div>
                  {downloadedZips.map((z) => (
                    <div
                      key={z.filename}
                      className="flex items-center justify-between gap-2 text-[11px] text-slate-300 font-mono tabular-nums"
                    >
                      <span className="truncate">{z.filename}</span>
                      <span className="shrink-0">
                        {z.fileCount} arq · {formatGameBytes(z.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#0C0F16] text-[11px] text-slate-400 border-b border-white/[0.06]">
                    <tr>
                      <th className="px-4 py-2 font-medium">Arquivo</th>
                      <th className="px-3 py-2 font-medium whitespace-nowrap">Status</th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap">Tamanho</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04] font-mono text-[11px] tabular-nums">
                    {fileRecords.map((rec, idx) => (
                      <tr key={`${rec.path}_${idx}`} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-1.5 text-slate-200 break-all">{rec.path}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {rec.status === 'uploaded' ? (
                            <span className="text-emerald-400">
                              {runMode === 'zip' ? 'No ZIP' : 'Enviado'}
                            </span>
                          ) : rec.status === 'skipped' ? (
                            <span className="text-slate-400">Pulado (igual)</span>
                          ) : (
                            <span className="text-red-400" title={rec.error}>
                              Erro
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-right text-slate-300 whitespace-nowrap">
                          {formatGameBytes(rec.size)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
