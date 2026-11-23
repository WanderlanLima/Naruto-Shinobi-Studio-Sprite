import { Archive, Download, Film, Grid } from 'lucide-react';

export type WorkspaceTab = 'ninjas' | 'studio' | 'backup';
export type TopBarActionIcon = 'export' | 'studio' | 'backup' | 'catalog';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  actionDisabled: boolean;
  actionLabel: string;
  actionIcon: TopBarActionIcon;
  onAction: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'ninjas', label: 'Catálogo' },
  { id: 'studio', label: 'Estúdio' },
  { id: 'backup', label: 'Backup' },
];

export function TopBar({
  activeTab,
  onTabChange,
  actionDisabled,
  actionLabel,
  actionIcon,
  onAction,
}: TopBarProps) {
  const renderActionIcon = () => {
    if (actionIcon === 'export') return <Download className="h-3.5 w-3.5" aria-hidden="true" />;
    if (actionIcon === 'studio') return <Film className="h-3.5 w-3.5" aria-hidden="true" />;
    if (actionIcon === 'backup') return <Archive className="h-3.5 w-3.5" aria-hidden="true" />;
    return <Grid className="h-3.5 w-3.5" aria-hidden="true" />;
  };

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#090B10]/95 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-8 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => onTabChange('ninjas')}
          className="font-display text-base font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          Shinobi Studio
        </button>

        <nav
          aria-label="Navegação principal"
          className="hidden md:flex items-center gap-8"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  isActive
                    ? 'text-slate-50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-orange-500"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            disabled={actionDisabled}
            onClick={onAction}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-slate-500 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            {renderActionIcon()}
            <span>{actionLabel}</span>
          </button>
        </div>
      </div>

      {/* Compact single-row mobile navigation */}
      <nav
        aria-label="Navegação móvel"
        className="flex md:hidden items-center justify-between border-t border-white/[0.06] px-2"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={`relative flex-1 min-h-[44px] py-2.5 text-center text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                isActive ? 'text-orange-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-4 bottom-0 h-0.5 bg-orange-500"
                />
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
