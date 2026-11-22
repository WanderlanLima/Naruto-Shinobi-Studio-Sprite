import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Scissors, Search, Smile } from 'lucide-react';
import type { GameAssetCategory, GameAssetEntry, SheetEntry } from '../types/sprite';
import { exportUrlAssetsAsZip, sliceImageUrlToZip } from '../utils/atlasParser';
import { resolveAssetFetchUrl } from '../utils/remoteClient';

interface GeneralAssetsViewProps {
  sheets: SheetEntry[];
  assets: GameAssetEntry[];
  onSendToSlicer: (proxyImageUrl: string, filename: string) => void;
}

const PAGE_SIZE = 48;

const ASSET_CATEGORY_LABELS: Record<GameAssetCategory, string> = {
  emoji: 'Emoji',
  hero: 'Herói',
  item: 'Item',
  ui: 'UI',
  bg: 'Cenário',
  sprite: 'Sprite',
  other: 'Outro',
};

const ASSET_CATEGORY_FOLDERS: Record<GameAssetCategory, string> = {
  emoji: 'emojis',
  hero: 'herois',
  item: 'itens',
  ui: 'ui',
  bg: 'cenarios',
  sprite: 'sprites',
  other: 'outros',
};

function getSheetKind(sheet: SheetEntry): 'astc_sheet' | 'spine_sheet' {
  if (sheet.sheetKind) return sheet.sheetKind;
  return sheet.name.toLowerCase().startsWith('no_') ? 'astc_sheet' : 'spine_sheet';
}

export function GeneralAssetsView({
  sheets,
  assets,
  onSendToSlicer,
}: GeneralAssetsViewProps) {
  const emojiAssets = useMemo(() => assets.filter((a) => a.category === 'emoji'), [assets]);
  const generalAssets = useMemo(() => assets.filter((a) => a.category !== 'emoji'), [assets]);

  const [subTab, setSubTab] = useState<'sheets' | 'emojis' | 'assets'>(() =>
    sheets.length > 0 ? 'sheets' : emojiAssets.length > 0 ? 'emojis' : 'assets'
  );
  const [search, setSearch] = useState('');
  const [sheetKindFilter, setSheetKindFilter] = useState<'all' | 'astc_sheet' | 'spine_sheet'>('all');
  const [sheetSizeFilter, setSheetSizeFilter] = useState<'all' | 'compact' | 'hd'>('all');
  const [category, setCategory] = useState<'all' | Exclude<GameAssetCategory, 'emoji'>>('all');
  const [page, setPage] = useState(1);

  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const sheetCounts = useMemo(() => {
    let astc = 0;
    let spine = 0;
    for (const s of sheets) {
      if (getSheetKind(s) === 'astc_sheet') astc++;
      else spine++;
    }
    return { all: sheets.length, astc, spine };
  }, [sheets]);

  const filteredSheets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sheets.filter((s) => {
      if (sheetKindFilter !== 'all' && getSheetKind(s) !== sheetKindFilter) return false;
      if (sheetSizeFilter === 'compact' && (s.bytes || 0) >= 1024 * 1024) return false;
      if (sheetSizeFilter === 'hd' && (s.bytes || 0) < 1024 * 1024) return false;
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sheets, sheetKindFilter, sheetSizeFilter, search]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return generalAssets.filter((a) => {
      if (category !== 'all' && a.category !== category) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.url.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [generalAssets, category, search]);

  const filteredEmojis = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? emojiAssets.filter(
          (a) => a.name.toLowerCase().includes(q) || a.url.toLowerCase().includes(q)
        )
      : emojiAssets;
  }, [emojiAssets, search]);

  useEffect(() => {
    setPage(1);
  }, [subTab, search, sheetKindFilter, sheetSizeFilter, category]);

  const activeTotal =
    subTab === 'sheets' ? filteredSheets.length : subTab === 'assets' ? filteredAssets.length : filteredEmojis.length;
  const totalPages = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedSheets = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredSheets.slice(start, start + PAGE_SIZE);
  }, [filteredSheets, safePage]);

  const pagedAssets = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredAssets.slice(start, start + PAGE_SIZE);
  }, [filteredAssets, safePage]);

  const handleBatchDownloadSheets = async () => {
    if (filteredSheets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    setBatchStatus(`Preparando ${filteredSheets.length} folhas...`);
    try {
      const items = filteredSheets.map((s) => ({
        zipPath: `${getSheetKind(s) === 'astc_sheet' ? 'folhas_astc' : 'folhas_spine'}/${s.name}`,
        fetchUrl: resolveAssetFetchUrl(s.url),
      }));
      const res = await exportUrlAssetsAsZip('shinobi_folhas_sprites.zip', items, (done, total, phase) => {
        setBatchStatus(
          phase === 'zipping' ? 'Gerando arquivo ZIP...' : `Baixando folhas: ${done}/${total}`
        );
      });
      setBatchStatus(
        `ZIP gerado com ${res.exported} folha(s)${res.failed > 0 ? ` (${res.failed} falha(s))` : ''}.`
      );
    } catch (err) {
      setBatchStatus(err instanceof Error ? err.message : 'Falha ao exportar folhas em ZIP.');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchDownloadAssets = async () => {
    if (filteredAssets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    setBatchStatus(`Preparando ${filteredAssets.length} arquivos...`);
    try {
      const items = filteredAssets.map((a) => ({
        zipPath: `${ASSET_CATEGORY_FOLDERS[a.category]}/${a.name}`,
        fetchUrl: resolveAssetFetchUrl(a.url),
      }));
      const res = await exportUrlAssetsAsZip('shinobi_ativos_ui_itens.zip', items, (done, total, phase) => {
        setBatchStatus(
          phase === 'zipping' ? 'Gerando arquivo ZIP...' : `Baixando ativos: ${done}/${total}`
        );
      });
      setBatchStatus(
        `ZIP gerado com ${res.exported} arquivo(s)${res.failed > 0 ? ` (${res.failed} falha(s))` : ''}.`
      );
    } catch (err) {
      setBatchStatus(err instanceof Error ? err.message : 'Falha ao exportar ativos em ZIP.');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSliceAndZipEmojiSheet = async (asset: GameAssetEntry) => {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchStatus(`Fatiando ${asset.name}...`);
    try {
      const proxyUrl = resolveAssetFetchUrl(asset.url);
      const count = await sliceImageUrlToZip(proxyUrl, 'shinobi_emojis_png.zip', {
        folder: 'emojis',
        filePrefix: 'emoji',
        alphaThreshold: 12,
        minSize: 12,
        mergeGap: 2,
      });
      setBatchStatus(`${count} emoji(s) exportados em shinobi_emojis_png.zip.`);
    } catch (err) {
      setBatchStatus(err instanceof Error ? err.message : 'Erro ao fatiar folha de emojis.');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSliceAndZipSingleSheet = async (sheet: SheetEntry) => {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchStatus(`Fatiando ${sheet.name}...`);
    try {
      const proxyUrl = resolveAssetFetchUrl(sheet.url);
      const base = sheet.name.replace(/\.[^.]+$/, '');
      const count = await sliceImageUrlToZip(proxyUrl, `${base}_fatiado.zip`, {
        folder: base,
        filePrefix: 'frame',
        alphaThreshold: 12,
        minSize: 8,
        mergeGap: 2,
      });
      setBatchStatus(`${count} frame(s) extraído(s) de ${sheet.name}.`);
    } catch (err) {
      setBatchStatus(err instanceof Error ? err.message : `Erro ao fatiar ${sheet.name}.`);
    } finally {
      setBatchBusy(false);
    }
  };

  if (sheets.length === 0 && assets.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center">
        <h2 className="font-display text-lg font-semibold text-slate-100">
          Nenhum ativo carregado
        </h2>
        <p className="mt-2 text-xs text-slate-400">
          Carregue uma fonte no Catálogo ou abra um backup offline para explorar folhas, emojis e interface.
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-white/[0.07] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50">Ativos</h1>
          <p className="mt-1 font-mono text-xs text-slate-400 tabular-nums">
            {sheets.length} folhas · {emojiAssets.length} emojis · {generalAssets.length} itens e interface
          </p>
        </div>

        {subTab === 'sheets' && (
          <button
            type="button"
            disabled={filteredSheets.length === 0 || batchBusy}
            onClick={() => void handleBatchDownloadSheets()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Baixar folhas ({filteredSheets.length})</span>
          </button>
        )}

        {subTab === 'assets' && (
          <button
            type="button"
            disabled={filteredAssets.length === 0 || batchBusy}
            onClick={() => void handleBatchDownloadAssets()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Baixar filtrados ({filteredAssets.length})</span>
          </button>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="inline-flex flex-wrap items-center rounded-lg border border-white/[0.07] bg-[#11141C] p-1 w-fit">
          <button
            type="button"
            onClick={() => setSubTab('sheets')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              subTab === 'sheets'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Folhas ({sheets.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('emojis')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              subTab === 'emojis'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Emojis ({emojiAssets.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('assets')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              subTab === 'assets'
                ? 'bg-orange-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Interface e Itens ({generalAssets.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {subTab === 'sheets' && (
            <>
              <select
                value={sheetKindFilter}
                onChange={(e) =>
                  setSheetKindFilter(e.target.value as 'all' | 'astc_sheet' | 'spine_sheet')
                }
                aria-label="Filtrar tipo de folha"
                className="rounded-lg border border-white/10 bg-[#11141C] px-3 py-2 text-xs text-slate-200 focus:border-orange-500/60 focus:outline-none cursor-pointer"
              >
                <option value="all">Todas ({sheetCounts.all})</option>
                <option value="astc_sheet">Spritesheets ({sheetCounts.astc})</option>
                <option value="spine_sheet">Spine ({sheetCounts.spine})</option>
              </select>

              <select
                value={sheetSizeFilter}
                onChange={(e) => setSheetSizeFilter(e.target.value as 'all' | 'compact' | 'hd')}
                aria-label="Filtrar por tamanho"
                className="rounded-lg border border-white/10 bg-[#11141C] px-3 py-2 text-xs text-slate-200 focus:border-orange-500/60 focus:outline-none cursor-pointer"
              >
                <option value="all">Qualquer tamanho</option>
                <option value="compact">Compactas (&lt; 1 MB)</option>
                <option value="hd">Alta resolução (&ge; 1 MB)</option>
              </select>
            </>
          )}

          {subTab === 'assets' && (
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as 'all' | Exclude<GameAssetCategory, 'emoji'>)
              }
              aria-label="Filtrar por categoria"
              className="rounded-lg border border-white/10 bg-[#11141C] px-3 py-2 text-xs text-slate-200 focus:border-orange-500/60 focus:outline-none cursor-pointer"
            >
              <option value="all">Todas categorias</option>
              <option value="item">Itens e ícones</option>
              <option value="hero">Heróis e expressões</option>
              <option value="ui">Interface</option>
              <option value="bg">Cenários</option>
              <option value="sprite">Sprites</option>
              <option value="other">Outros</option>
            </select>
          )}

          <div className="relative min-w-[200px] flex-1 sm:flex-initial">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar arquivo..."
              aria-label="Buscar arquivo"
              className="w-full rounded-lg border border-white/10 bg-[#11141C] py-2 pl-8 pr-3 text-sm sm:text-xs text-slate-100 placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {batchStatus && (
        <div className="rounded-lg border border-white/[0.08] bg-[#11141C] px-4 py-2.5 font-mono text-xs text-slate-300 tabular-nums">
          {batchStatus}
        </div>
      )}

      {subTab === 'sheets' && (
        <>
          {pagedSheets.length === 0 ? (
            <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center text-xs text-slate-400">
              Nenhuma folha encontrada para os filtros atuais.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {pagedSheets.map((sheet) => {
                const proxyUrl = resolveAssetFetchUrl(sheet.url);
                const kindLabel = getSheetKind(sheet) === 'astc_sheet' ? 'Spritesheet' : 'Spine';
                return (
                  <div
                    key={sheet.url}
                    className="flex flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[#11141C]"
                  >
                    <div className="sprite-checkerboard flex h-44 items-center justify-center p-3">
                      <img
                        src={proxyUrl}
                        alt={sheet.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div className="flex flex-col gap-2.5 border-t border-white/[0.06] p-3">
                      <div>
                        <div
                          className="truncate font-mono text-xs font-medium text-slate-100"
                          title={sheet.name}
                        >
                          {sheet.name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                          {sheet.width && sheet.height ? `${sheet.width}×${sheet.height}` : 'Imagem'}
                          {sheet.bytes ? ` · ${(sheet.bytes / (1024 * 1024)).toFixed(2)} MB` : ''}
                          {` · ${kindLabel}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSendToSlicer(proxyUrl, sheet.name)}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white cursor-pointer whitespace-nowrap"
                        >
                          <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Fatiar</span>
                        </button>
                        <button
                          type="button"
                          disabled={batchBusy}
                          onClick={() => void handleSliceAndZipSingleSheet(sheet)}
                          title="Fatiar automaticamente e baixar PNGs em ZIP"
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-white/25 hover:text-white disabled:opacity-40 cursor-pointer whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>PNGs</span>
                        </button>
                        <a
                          href={proxyUrl}
                          download={sheet.name}
                          className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-[#090B10] p-1.5 text-slate-400 hover:border-white/25 hover:text-white"
                          aria-label={`Baixar ${sheet.name}`}
                          title="Baixar folha original"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {subTab === 'emojis' && (
        <>
          {filteredEmojis.length === 0 ? (
            <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center text-xs text-slate-400">
              Nenhuma folha de emojis encontrada.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {filteredEmojis.map((asset) => {
                const proxyUrl = resolveAssetFetchUrl(asset.url);
                return (
                  <div
                    key={asset.url}
                    className="flex flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[#11141C]"
                  >
                    <div className="sprite-checkerboard flex min-h-60 items-center justify-center p-4">
                      <img
                        src={proxyUrl}
                        alt={asset.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="max-h-72 max-w-full object-contain"
                      />
                    </div>
                    <div className="flex flex-col gap-3 border-t border-white/[0.06] p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-display text-sm font-semibold text-slate-100">
                          <Smile className="h-4 w-4 text-orange-400 shrink-0" aria-hidden="true" />
                          <span className="truncate">{asset.name}</span>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-500 uppercase">
                          {asset.ext} · Folha de emojis
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={batchBusy}
                          onClick={() => void handleSliceAndZipEmojiSheet(asset)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Extrair PNGs (ZIP)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onSendToSlicer(proxyUrl, asset.name)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-200 hover:border-white/25 hover:text-white cursor-pointer whitespace-nowrap"
                        >
                          <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Fatiar</span>
                        </button>
                        <a
                          href={proxyUrl}
                          download={asset.name}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs font-medium text-slate-300 hover:border-white/25 hover:text-white whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Original</span>
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {subTab === 'assets' && (
        <>
          {pagedAssets.length === 0 ? (
            <div className="rounded-xl border border-white/[0.07] bg-[#11141C] p-10 text-center text-xs text-slate-400">
              Nenhum ativo encontrado nesta categoria.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {pagedAssets.map((asset) => {
                const proxyUrl = resolveAssetFetchUrl(asset.url);
                return (
                  <div
                    key={asset.url}
                    className="flex flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[#11141C]"
                  >
                    <div className="sprite-checkerboard flex h-32 items-center justify-center p-2">
                      <img
                        src={proxyUrl}
                        alt={asset.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5 border-t border-white/[0.06] p-2.5">
                      <div
                        className="truncate font-mono text-xs text-slate-100"
                        title={asset.name}
                      >
                        {asset.name}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span className="font-mono uppercase truncate">
                          {asset.ext} · {ASSET_CATEGORY_LABELS[asset.category]}
                        </span>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => onSendToSlicer(proxyUrl, asset.name)}
                            title="Abrir no Fatiador"
                            className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-orange-400 cursor-pointer"
                          >
                            <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <a
                            href={proxyUrl}
                            download={asset.name}
                            title="Baixar arquivo"
                            className="rounded p-1 text-slate-400 hover:bg-white/[0.06] hover:text-white"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {subTab !== 'emojis' && totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-white/[0.07] pt-4">
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            Página {safePage} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/20 disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Anterior</span>
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#11141C] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/20 disabled:opacity-40 cursor-pointer"
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
