import type React from 'react';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { Drawer } from '../common/Drawer';
import { SidebarNav } from './SidebarNav';
import { cn } from '../../utils/cn';
import { ThemeToggle } from '../theme/ThemeToggle';
import { UiLanguageToggle } from '../i18n/UiLanguageToggle';
import { useUiLanguage } from '../../contexts/UiLanguageContext';

type ShellProps = {
  children?: React.ReactNode;
};

export const Shell: React.FC<ShellProps> = ({ children }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = true;
  const { t } = useUiLanguage();

  useEffect(() => {
    if (!mobileOpen) {
      return undefined;
    }

    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setMobileOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [mobileOpen]);

  return (
    <div data-testid="stockmaster-shell" className="stockmaster-shell sm-reference-shell min-h-screen bg-[var(--sm-canvas)] text-foreground">
      <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex items-start justify-between px-3 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-card/85 text-secondary-text shadow-soft-card backdrop-blur-md transition-colors hover:bg-hover hover:text-foreground"
          aria-label={t('layout.openNav')}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="pointer-events-auto flex items-center gap-2">
          <UiLanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      <div className="sm-reference-frame flex min-h-screen w-full">
        <aside
          data-testid="stockmaster-sidebar"
          className={cn(
            'stockmaster-sidebar sm-reference-rail sticky top-0 z-40 hidden w-14 min-w-0 shrink-0 overflow-visible border-r border-[var(--sm-rail-border)] bg-[var(--sm-rail-bg)] p-2 transition-[width] duration-200 lg:flex',
            'h-screen max-h-screen self-start',
            collapsed ? 'w-14' : 'w-[220px]'
          )}
          style={!collapsed ? { width: 'var(--sm-rail-width)' } : undefined}
          aria-label={t('layout.desktopSidebar')}
        >
          <SidebarNav collapsed={collapsed} variant="rail" onNavigate={() => setMobileOpen(false)} />
        </aside>

        <main className="sm-reference-main min-h-0 min-w-0 flex-1 pt-14 lg:pt-0 touch-pan-y">
          {children ?? <Outlet />}
        </main>
      </div>

      <Drawer
        isOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        title={t('layout.navMenu')}
        width="max-w-xs"
        zIndex={90}
        side="left"
      >
        <SidebarNav onNavigate={() => setMobileOpen(false)} />
      </Drawer>
    </div>
  );
};
