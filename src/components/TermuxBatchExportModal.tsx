import { useState } from 'react';
import { Check, Copy, Download, Terminal, X } from 'lucide-react';
import type { NinjaEntry } from '../types/sprite';
import type { EffectIncludeScope } from '../utils/completeCharacterExporter';
import { downloadTermuxBatchExportScript } from '../utils/termuxCharacterExportScript';
import { markManyNinjasExported } from '../utils/ninjaCollectionsStore';

interface TermuxBatchExportModalProps {
  open: boolean;
  ninjas: NinjaEntry[];
  sourceLabel: string;
  onClose: () => void;
}

type ExportPresetId = 'engine' | 'complete' | 'preview';

export function TermuxBatchExportModal({
  open,
  ninjas,
  sourceLabel,
  onClose,
}: TermuxBatchExportModalProps) {
  const [preset, setPreset] = useState<ExportPresetId>('engine');
  const [skipExisting, setSkipExisting] = useState(true);
  const [markAsExported, setMarkAsExported] = useState(true);
  const [fps, setFps] = useState(24);
  const [maxResolution, setMaxResolution] = useState(1024);
  const [effectScope, setEffectScope] = useState<EffectIncludeScope>('all');
  const [includeAnimPngsAndSheets, setIncludeAnimPngsAndSheets] = useState(true);
  const [includeAnimGifs, setIncludeAnimGifs] = useState(false);
  const [includeOriginalAndFrames, setIncludeOriginalAndFrames] = useState(true);
  const [includeLinkedEffects, setIncludeLinkedEffects] = useState(true);
  const [includePassiveAura, setIncludePassiveAura] = useState(true);
  const [includeVideosAndAudio, setIncludeVideosAndAudio] = useState(true);
  const [includeSkillIcons, setIncludeSkillIcons] = useState(true);
  const [includeCharacterArtworks, setIncludeCharacterArtworks] = useState(true);
  const [generated, setGenerated] = useState<{
    scriptFilename: string;
    command: string;
    count: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const applyPreset = (id: ExportPresetId) => {
    setPreset(id);
    if (id === 'engine') {
      setEffectScope('all');
      setIncludeOriginalAndFrames(true);
      setIncludeLinkedEffects(true);
      setIncludeAnimPngsAndSheets(true);
      setIncludeAnimGifs(false);
      setIncludePassiveAura(true);
      setIncludeVideosAndAudio(true);
      setIncludeSkillIcons(true);
      setIncludeCharacterArtworks(true);
      setFps(24);
      setMaxResolution(1024);
    } else if (id === 'complete') {
      setEffectScope('all');
      setIncludeOriginalAndFrames(true);
      setIncludeLinkedEffects(true);
      setIncludeAnimPngsAndSheets(true);
      setIncludeAnimGifs(true);
      setIncludePassiveAura(true);
      setIncludeVideosAndAudio(true);
      setIncludeSkillIcons(true);
      setIncludeCharacterArtworks(true);
      setFps(24);
      setMaxResolution(2048);
    } else {
      setEffectScope('powers');
      setIncludeOriginalAndFrames(false);
      setIncludeLinkedEffects(false);
      setIncludeAnimPngsAndSheets(false);
      setIncludeAnimGifs(true);
      setIncludePassiveAura(true);
      setIncludeVideosAndAudio(false);
      setIncludeSkillIcons(false);
      setIncludeCharacterArtworks(true);
      setFps(18);
      setMaxResolution(768);
    }
  };

  const handleGenerate = () => {
    if (ninjas.length === 0) return;
    const res = downloadTermuxBatchExportScript({
      ninjas,
      label: sourceLabel,
      skipExisting,
      effectScope,
      includeOriginalAndFrames,
      includeLinkedEffects,
      includeAnimPngsAndSheets,
      includeAnimGifs,
      includePassiveAura,
      includeVideosAndAudio,
      includeSkillIcons,
      includeCharacterArtworks,
      gifBg: 'transparent',
      fps,
      maxResolution,
    });
    if (markAsExported) {
      markManyNinjasExported(
        ninjas.map((n) => n.id),
        'termux'
      );
    }
    setGenerated(res);
    setCopied(false);
  };

  const handleCopy = () => {
    if (!generated) return;
    navigator.clipboard?.writeText(generated.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/[0.1] bg-[#11141C] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-100">
              Exportação em lote via Termux
            </h2>
            <p className="mt-1 text-xs text-slate-400 tabular-nums">
              {ninjas.length.toLocaleString('pt-BR')} personagem(ns) · {sourceLabel} · 1 único script{' '}
              <span className="font-mono text-slate-300">.sh</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar modal"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* 3 Presets */}
          <div className="space-y-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Perfil de exportação
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    id: 'engine',
                    title: 'Game Engine',
                    desc: 'Spritesheets + JSON pivô/eventos, áudios, vídeos e artes (1024px)',
                  },
                  {
                    id: 'complete',
                    title: 'Completo',
                    desc: 'Tudo em qualidade máxima + GIFs animados (2048px)',
                  },
                  {
                    id: 'preview',
                    title: 'Preview leve',
                    desc: 'Apenas GIFs + artes PNG em tamanho reduzido (768px)',
                  },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => applyPreset(item.id)}
                  className={`rounded-lg border p-3 text-left transition-colors cursor-pointer ${
                    preset === item.id
                      ? 'border-orange-500/70 bg-orange-500/10'
                      : 'border-white/[0.08] bg-[#0C0F16] hover:border-white/20'
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-100">{item.title}</div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-400">{item.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Resume & Tracking checkboxes */}
          <div className="space-y-2 rounded-lg border border-white/[0.07] bg-[#0C0F16] p-3 text-xs text-slate-300">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={skipExisting}
                onChange={(e) => setSkipExisting(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-orange-500"
              />
              <span>
                <strong className="font-medium text-slate-100">Pular já exportados na pasta Downloads</strong>
                <span className="block text-[11px] text-slate-400">
                  Se o celular parar no meio, basta rodar o mesmo script novamente para continuar de onde parou.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={markAsExported}
                onChange={(e) => setMarkAsExported(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-orange-500"
              />
              <span>
                <strong className="font-medium text-slate-100">Marcar estes ninjas como "Já exportado" no catálogo</strong>
                <span className="block text-[11px] text-slate-400">
                  Facilita filtrar depois quais personagens ainda faltam para o seu jogo.
                </span>
              </span>
            </label>
          </div>

          {/* Collapsible Advanced Options */}
          <details className="rounded-lg border border-white/[0.07] bg-[#0C0F16] px-3 py-2.5 text-xs">
            <summary className="cursor-pointer font-medium text-slate-300 hover:text-slate-100">
              Ajustes avançados (FPS, resolução, conteúdo)
            </summary>
            <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
              <div className="grid grid-cols-2 gap-2.5">
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-400">FPS</span>
                  <select
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    className="w-full rounded-md border border-white/[0.08] bg-[#11141C] px-2.5 py-1.5 text-xs text-slate-100"
                  >
                    <option value={15}>15 FPS</option>
                    <option value={18}>18 FPS</option>
                    <option value={24}>24 FPS</option>
                    <option value={30}>30 FPS</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-400">Resolução máxima</span>
                  <select
                    value={maxResolution}
                    onChange={(e) => setMaxResolution(Number(e.target.value))}
                    className="w-full rounded-md border border-white/[0.08] bg-[#11141C] px-2.5 py-1.5 text-xs text-slate-100"
                  >
                    <option value={768}>768 px</option>
                    <option value={1024}>1024 px</option>
                    <option value={1536}>1536 px</option>
                    <option value={2048}>2048 px</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeAnimPngsAndSheets}
                    onChange={(e) => setIncludeAnimPngsAndSheets(e.target.checked)}
                    className="accent-orange-500"
                  />
                  Spritesheets + JSON pivô
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeAnimGifs}
                    onChange={(e) => setIncludeAnimGifs(e.target.checked)}
                    className="accent-orange-500"
                  />
                  GIFs animados
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeVideosAndAudio}
                    onChange={(e) => setIncludeVideosAndAudio(e.target.checked)}
                    className="accent-orange-500"
                  />
                  Vídeos MP4 + Áudios MP3
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeCharacterArtworks}
                    onChange={(e) => setIncludeCharacterArtworks(e.target.checked)}
                    className="accent-orange-500"
                  />
                  Artes PNG + Ícones
                </label>
              </div>
            </div>
          </details>

          {/* Included preview list */}
          <div className="text-[11px] text-slate-400">
            <span className="font-medium text-slate-300">Personagens no lote: </span>
            <span>
              {ninjas
                .slice(0, 8)
                .map((n) => n.name || n.id)
                .join(', ')}
              {ninjas.length > 8 ? ` e mais ${ninjas.length - 8}...` : ''}
            </span>
          </div>

          {generated && (
            <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-emerald-300">
                <span className="inline-flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Script baixado ({generated.count} ninjas)
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 cursor-pointer"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copiado' : 'Copiar comando'}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-[#090B10] px-3 py-2 font-mono text-[11px] text-slate-200">
                {generated.command}
              </pre>
              <p className="text-[11px] text-slate-400">
                Cole no Termux. Ele detecta automaticamente seu backup .zip offline em Downloads e gera um{' '}
                <span className="font-mono text-slate-300">&lt;id&gt;_completo.zip</span> por personagem com{' '}
                <span className="font-mono text-slate-300">_spritesheet.json</span> (pivô + eventos em ms).
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/[0.1] px-4 py-2 text-xs font-medium text-slate-300 hover:border-white/25 hover:text-white cursor-pointer"
          >
            Fechar
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Baixar script Termux ({ninjas.length})</span>
          </button>
        </div>
      </div>
    </div>
  );
}
