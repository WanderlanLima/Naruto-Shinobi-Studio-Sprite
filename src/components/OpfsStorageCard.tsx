import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import {
  clearOpfsInternalCopy,
  getOpfsBackupUsage,
  useOfflineZipState,
  type OpfsBackupUsageInfo,
} from '../utils/offlineZipStore';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function OpfsStorageCard() {
  const offlineZip = useOfflineZipState();
  const [usage, setUsage] = useState<OpfsBackupUsageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    setLoading(true);
    try {
      const info = await getOpfsBackupUsage();
      setUsage(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage, offlineZip.generation, offlineZip.opfsSync.storedInOpfs]);

  const handleClearOpfs = async () => {
    setClearing(true);
    setNotice(null);
    try {
      const res = await clearOpfsInternalCopy();
      setConfirmClear(false);
      await refreshUsage();
      if (res.freedBytes > 0) {
        setNotice(
          res.unmountedActiveSession
            ? `Cópia interna removida (${formatBytes(res.freedBytes)} liberados). Seu .ZIP original em Downloads permanece intacto — basta reabri-lo quando quiser.`
            : `Cópia interna removida (${formatBytes(res.freedBytes)} liberados). Seu backup atual continua aberto nesta sessão.`
        );
      } else {
        setNotice('Nenhuma cópia interna ocupando espaço no navegador.');
      }
    } finally {
      setClearing(false);
    }
  };

  const opfsBytes = usage?.bytes ?? 0;
  const hasInternalCopy = opfsBytes > 0 || offlineZip.opfsSync.storedInOpfs;
  const quotaPct =
    usage?.browserQuotaBytes && usage.browserUsageBytes !== null
      ? Math.min(100, Math.round((usage.browserUsageBytes / usage.browserQuotaBytes) * 100))
      : null;

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#11141C] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Armazenamento interno do navegador (OPFS)
          </h3>
        </div>
        <button
          type="button"
          onClick={() => void refreshUsage()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:border-white/20 hover:text-white disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          <span>Atualizar</span>
        </button>
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        Para reabrir o Modo Offline sem pedir permissão toda vez, o navegador guarda uma cópia interna do{' '}
        <span className="font-mono text-slate-300">.zip</span> além do arquivo original na pasta Downloads.
        Se quiser liberar espaço no aparelho, remova apenas a cópia interna abaixo.
      </p>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-white/[0.06] bg-[#0C0F16] p-3 text-xs tabular-nums sm:grid-cols-3">
        <div>
          <div className="text-[11px] text-slate-500">Cópia interna do backup</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-100">
            {usage ? formatBytes(opfsBytes) : '...'}
          </div>
          <div className="text-[11px] text-slate-500">
            {usage ? `${usage.fileCount} arquivo(s)` : ''}
          </div>
        </div>

        <div>
          <div className="text-[11px] text-slate-500">Uso total do app</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-200">
            {usage?.browserUsageBytes !== null && usage ? formatBytes(usage.browserUsageBytes) : '—'}
          </div>
          <div className="text-[11px] text-slate-500">
            {quotaPct !== null ? `${quotaPct}% da cota` : 'Cota indisponível'}
          </div>
        </div>

        <div className="col-span-2 sm:col-span-1 flex items-center sm:justify-end">
          {!confirmClear ? (
            <button
              type="button"
              disabled={!hasInternalCopy || clearing || offlineZip.opfsSync.active}
              onClick={() => setConfirmClear(true)}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-40 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Limpar cópia interna</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={clearing}
                onClick={() => void handleClearOpfs()}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50 cursor-pointer"
              >
                {clearing ? 'Limpando...' : 'Confirmar limpeza'}
              </button>
            </div>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-emerald-300">{notice}</p>}
    </div>
  );
}
