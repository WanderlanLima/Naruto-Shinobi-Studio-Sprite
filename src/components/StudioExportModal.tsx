import { Check, ChevronDown, Copy, Download, Terminal, X } from 'lucide-react';
import type { NinjaEntry, NinjaMediaProfile } from '../types/sprite';
import type {
  CompleteExportProgress,
  EffectIncludeScope,
} from '../utils/completeCharacterExporter';
import type { ExportCheckpointJobMeta } from '../utils/exportCheckpointStore';

export type StudioExportPresetId = 'engine' | 'complete' | 'preview';

export interface StudioExportModalProps {
  open: boolean;
  ninja: NinjaEntry;
  mediaProfile: NinjaMediaProfile | null;
  framesCount: number;
  animNamesCount: number;
  uniqueEffectsCount: number;
  skillIconCount: number;
  activeExportPreset: StudioExportPresetId | 'custom';
  onApplyPreset: (preset: StudioExportPresetId) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  effectScope: EffectIncludeScope;
  onEffectScopeChange: (val: EffectIncludeScope) => void;
  includeOriginals: boolean;
  onIncludeOriginalsChange: (val: boolean) => void;
  includeEffects: boolean;
  onIncludeEffectsChange: (val: boolean) => void;
  includeAnimPngs: boolean;
  onIncludeAnimPngsChange: (val: boolean) => void;
  includeAnimGifs: boolean;
  onIncludeAnimGifsChange: (val: boolean) => void;
  gifBg: 'transparent' | 'dark' | 'light' | 'chroma';
  onGifBgChange: (val: 'transparent' | 'dark' | 'light' | 'chroma') => void;
  exportFps: 24 | 15 | 12;
  onExportFpsChange: (val: 24 | 15 | 12) => void;
  exportMaxRes: 2048 | 1024 | 512;
  onExportMaxResChange: (val: 2048 | 1024 | 512) => void;
  includePassiveAura: boolean;
  onIncludePassiveAuraChange: (val: boolean) => void;
  includeSkillIcons: boolean;
  onIncludeSkillIconsChange: (val: boolean) => void;
  includeVideosAndAudio: boolean;
  onIncludeVideosAndAudioChange: (val: boolean) => void;
  includeArtworks: boolean;
  onIncludeArtworksChange: (val: boolean) => void;
  ninjaCheckpoint: ExportCheckpointJobMeta | null;
  onClearCheckpoint: () => void;
  termuxExportResult: { scriptFilename: string; zipFilename: string; command: string } | null;
  onDismissTermuxResult: () => void;
  copiedTermuxCmd: boolean;
  onCopyTermuxCmd: () => void;
  progress: CompleteExportProgress | null;
  error: string | null;
  onClose: () => void;
  onCancelExport: () => void;
  onRunTermuxExport: () => void;
  onRunBrowserExport: () => void;
}

export function StudioExportModal({
  open,
  ninja,
  mediaProfile,
  framesCount,
  animNamesCount,
  uniqueEffectsCount,
  skillIconCount,
  activeExportPreset,
  onApplyPreset,
  showAdvanced,
  onToggleAdvanced,
  effectScope,
  onEffectScopeChange,
  includeOriginals,
  onIncludeOriginalsChange,
  includeEffects,
  onIncludeEffectsChange,
  includeAnimPngs,
  onIncludeAnimPngsChange,
  includeAnimGifs,
  onIncludeAnimGifsChange,
  gifBg,
  onGifBgChange,
  exportFps,
  onExportFpsChange,
  exportMaxRes,
  onExportMaxResChange,
  includePassiveAura,
  onIncludePassiveAuraChange,
  includeSkillIcons,
  onIncludeSkillIconsChange,
  includeVideosAndAudio,
  onIncludeVideosAndAudioChange,
  includeArtworks,
  onIncludeArtworksChange,
  ninjaCheckpoint,
  onClearCheckpoint,
  termuxExportResult,
  onDismissTermuxResult,
  copiedTermuxCmd,
  onCopyTermuxCmd,
  progress,
  error,
  onClose,
  onCancelExport,
  onRunTermuxExport,
  onRunBrowserExport,
}: StudioExportModalProps) {
  if (!open) return null;

  const nothingSelected =
    !includeOriginals &&
    !includeEffects &&
    !includeAnimPngs &&
    !includeAnimGifs &&
    !includeVideosAndAudio &&
    !includeSkillIcons &&
    !includeArtworks;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="complete-char-export-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !progress) {
          onClose();
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
              {framesCount} frames · {animNamesCount} animações · {uniqueEffectsCount} efeitos
            </p>
          </div>
          <button
            type="button"
            disabled={Boolean(progress)}
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-40 cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          {/* 3 quick export presets */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-300">Perfil de exportação</span>
              {activeExportPreset === 'custom' && (
                <span className="text-[11px] text-orange-300">Personalizado</span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    id: 'engine',
                    title: 'Game Engine',
                    desc: 'Spritesheets + JSON pivô/eventos (Phaser/Godot/Unity), áudio e artes',
                  },
                  {
                    id: 'complete',
                    title: 'Completo',
                    desc: 'Tudo incluído + GIFs transparentes em 24 FPS',
                  },
                  {
                    id: 'preview',
                    title: 'Preview leve',
                    desc: 'GIFs 15 FPS, artes PNG, vídeos e vozes',
                  },
                ] as const
              ).map((preset) => {
                const isSelected = activeExportPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={Boolean(progress)}
                    onClick={() => onApplyPreset(preset.id)}
                    aria-pressed={isSelected}
                    className={`rounded-lg border p-3 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                      isSelected
                        ? 'border-orange-500 bg-orange-500/12 text-slate-50'
                        : 'border-white/[0.08] bg-[#090B10] text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <div className="font-semibold text-xs text-slate-100">{preset.title}</div>
                    <div className="mt-1 text-[11px] leading-snug text-slate-400">
                      {preset.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Concise unboxed summary of included assets */}
          <p className="text-[11px] leading-relaxed text-slate-400 tabular-nums">
            {[
              includeOriginals ? 'Originais Spine' : null,
              includeEffects ? 'Partículas e Combate JSON' : null,
              includeAnimPngs ? `Sheets + JSON pivô/ms (${exportFps} FPS)` : null,
              includeAnimGifs ? `GIFs (${exportFps} FPS)` : null,
              includeVideosAndAudio ? 'Vídeos e Áudios' : null,
              includeSkillIcons ? `${skillIconCount} ícones` : null,
              ninja.kind !== 'effect' && includeArtworks ? 'Artes PNG' : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Nenhum item selecionado'}
          </p>

          {/* Collapsible advanced customization */}
          <div className="border-t border-white/[0.07] pt-2.5">
            <button
              type="button"
              onClick={onToggleAdvanced}
              aria-expanded={showAdvanced}
              className="flex w-full items-center justify-between py-1 text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
            >
              <span>Personalizar opções avançadas</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                  showAdvanced ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>

            {showAdvanced && (
              <div className="mt-2.5 space-y-3">
                <label className="block space-y-1.5">
                  <span className="font-medium text-slate-300">Camadas de efeitos</span>
                  <select
                    disabled={Boolean(progress)}
                    value={effectScope}
                    onChange={(e) => onEffectScopeChange(e.target.value as EffectIncludeScope)}
                    className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
                  >
                    <option value="all">Completo (poderes + impactos)</option>
                    <option value="powers">Apenas poderes do personagem</option>
                    <option value="base">Somente personagem</option>
                  </select>
                </label>

                <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#090B10]">
                  <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(progress)}
                      checked={includeOriginals}
                      onChange={(e) => onIncludeOriginalsChange(e.target.checked)}
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
                      disabled={Boolean(progress)}
                      checked={includeEffects}
                      onChange={(e) => onIncludeEffectsChange(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Partículas, combate e instruções
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Pacotes de partículas, roteiro de animações (com timestamps em ms) e ficha de skills/perseguições em JSON.
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={Boolean(progress)}
                      checked={includeAnimPngs}
                      onChange={(e) => onIncludeAnimPngsChange(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">
                        Sequências PNG, spritesheets e JSON Game Engine
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Gera spritesheet PNG + <span className="font-mono">_spritesheet.json</span> (Phaser/Godot/Unity) com pivô dos pés e eventos em ms ({exportFps} FPS).
                      </div>
                    </div>
                  </label>

                  <div className="p-3 space-y-2">
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={Boolean(progress)}
                        checked={includeAnimGifs}
                        onChange={(e) => onIncludeAnimGifsChange(e.target.checked)}
                        className="mt-0.5 accent-orange-500"
                      />
                      <div>
                        <div className="font-medium text-slate-100">GIFs animados</div>
                        <div className="text-[11px] text-slate-400">
                          Um arquivo GIF pronto para cada animação.
                        </div>
                      </div>
                    </label>
                    {includeAnimGifs && (
                      <div className="flex items-center justify-between gap-2 pl-6">
                        <span className="text-[11px] text-slate-400">Fundo dos GIFs</span>
                        <select
                          disabled={Boolean(progress)}
                          value={gifBg}
                          onChange={(e) =>
                            onGifBgChange(
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

                  {(includeAnimPngs || includeAnimGifs) && (
                    <div className="grid grid-cols-2 gap-2.5 p-3 bg-white/[0.015]">
                      <label className="space-y-1">
                        <span className="block text-[11px] text-slate-400">Taxa de quadros</span>
                        <select
                          disabled={Boolean(progress)}
                          value={exportFps}
                          onChange={(e) =>
                            onExportFpsChange(Number(e.target.value) as 24 | 15 | 12)
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
                          disabled={Boolean(progress)}
                          value={exportMaxRes}
                          onChange={(e) =>
                            onExportMaxResChange(Number(e.target.value) as 2048 | 1024 | 512)
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
                        disabled={Boolean(progress)}
                        checked={includePassiveAura}
                        onChange={(e) => onIncludePassiveAuraChange(e.target.checked)}
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
                      disabled={Boolean(progress)}
                      checked={includeSkillIcons}
                      onChange={(e) => onIncludeSkillIconsChange(e.target.checked)}
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
                      disabled={Boolean(progress)}
                      checked={includeVideosAndAudio}
                      onChange={(e) => onIncludeVideosAndAudioChange(e.target.checked)}
                      className="mt-0.5 accent-orange-500"
                    />
                    <div>
                      <div className="font-medium text-slate-100">Vídeos e áudios</div>
                      <div className="text-[11px] text-slate-400">
                        {mediaProfile?.videos.length || 0} vídeo(s) MP4 e{' '}
                        {mediaProfile?.voices.length || 0} voz(es)/efeitos MP3.
                      </div>
                    </div>
                  </label>

                  {ninja.kind !== 'effect' && (
                    <label className="flex items-start gap-2.5 p-3 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={Boolean(progress)}
                        checked={includeArtworks}
                        onChange={(e) => onIncludeArtworksChange(e.target.checked)}
                        className="mt-0.5 accent-orange-500"
                      />
                      <div>
                        <div className="font-medium text-slate-100">
                          Artes oficiais do ninja (PNG)
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Arte completa, meio corpo, retratos, avatar, close-up, expressões e arte do nome em{' '}
                          <span className="font-mono">artes/</span>.
                        </div>
                      </div>
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {ninjaCheckpoint && !progress && (
          <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2 text-amber-100">
              <span className="font-medium">
                Progresso salvo encontrado ({ninjaCheckpoint.completedAnims.length}/
                {ninjaCheckpoint.totalAnims} animações prontas)
              </span>
              <button
                type="button"
                onClick={onClearCheckpoint}
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

        {termuxExportResult && !progress && (
          <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/20 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-emerald-200">
                <Terminal className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                <span>Script Termux baixado</span>
              </div>
              <button
                type="button"
                onClick={onDismissTermuxResult}
                aria-label="Fechar aviso Termux"
                className="text-emerald-300/70 hover:text-white cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <p className="text-[11px] text-emerald-100/85">
              Abra o Termux e rode o comando abaixo. Ele detecta automaticamente seu backup{' '}
              <span className="font-mono">.zip</span> em <span className="font-mono">Downloads</span>,
              usa todos os núcleos da CPU e salva{' '}
              <span className="font-mono text-emerald-200">{termuxExportResult.zipFilename}</span>{' '}
              com spritesheets + JSON de pivô/eventos em <span className="font-mono">Downloads</span>:
            </p>
            <div className="flex items-center gap-2 rounded-md border border-white/10 bg-[#090B10] px-2.5 py-2">
              <code className="flex-1 overflow-x-auto font-mono text-[11px] text-emerald-300 whitespace-nowrap">
                {termuxExportResult.command}
              </code>
              <button
                type="button"
                onClick={onCopyTermuxCmd}
                className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-600/25 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-600/40 cursor-pointer"
              >
                {copiedTermuxCmd ? (
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

        {progress && (
          <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-[#090B10] p-3">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="truncate text-slate-200">{progress.message}</span>
              <span className="ml-2 shrink-0 text-orange-400">{progress.percent}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full bg-orange-500 transition-all duration-150"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-400">
              Progresso salvo automaticamente a cada animação concluída.
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-950/25 px-3 py-2 text-xs text-red-200"
          >
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {progress ? (
            <button
              type="button"
              onClick={onCancelExport}
              className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-950/60 cursor-pointer"
            >
              Cancelar
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-white/25 cursor-pointer"
              >
                Fechar
              </button>
              <button
                type="button"
                disabled={nothingSelected}
                onClick={onRunTermuxExport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:border-emerald-400/70 hover:bg-emerald-900/50 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Extrair pelo Termux (.sh)</span>
              </button>
              <button
                type="button"
                disabled={nothingSelected}
                onClick={onRunBrowserExport}
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
  );
}
