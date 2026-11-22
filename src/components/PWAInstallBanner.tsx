import { useState } from 'react';
import { Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallAction() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isInstallable) {
            void install();
          } else {
            setShowGuide(true);
          }
        }}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors cursor-pointer whitespace-nowrap"
      >
        <Smartphone className="h-3.5 w-3.5 text-orange-400" aria-hidden="true" />
        <span>Instalar aplicativo</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowGuide(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#11141C] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="pwa-install-title" className="font-display text-base font-semibold text-slate-50">
                Instalar como aplicativo
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Fechar instruções"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-slate-300">
              {isIOS ? (
                <ol className="list-decimal space-y-2 pl-4">
                  <li>Abra este endereço no <strong>Safari</strong>.</li>
                  <li>Toque em <strong>Compartilhar</strong>.</li>
                  <li>Selecione <strong>Adicionar à Tela de Início</strong>.</li>
                </ol>
              ) : (
                <ol className="list-decimal space-y-2 pl-4">
                  <li>No <strong>Android (Chrome / Edge)</strong>, abra o menu do navegador e toque em <strong>Instalar aplicativo</strong>.</li>
                  <li>No <strong>iPhone / iPad (Safari)</strong>, toque em <strong>Compartilhar</strong> e em <strong>Adicionar à Tela de Início</strong>.</li>
                  <li>No <strong>PC</strong>, clique no ícone de instalação na barra de endereço.</li>
                </ol>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full rounded-lg bg-orange-600 py-2.5 text-xs font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-[#11141C] px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
      <span>Modo offline ativo</span>
    </div>
  );
}
