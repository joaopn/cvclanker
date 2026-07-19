/**
 * Shared layout components for consistent page structure.
 */

import { useProfileSwitch } from "@client/hooks/useProfileSwitch";
import { ExternalLink, type LucideIcon, Menu } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { getAppVersion } from "../lib/version";
import { isNavActive, NAV_LINKS } from "./navigation";
import { ProfileSwitchOverlay } from "./ProfileSwitchOverlay";
import { StatusBadgeIndicator } from "./StatusIndicator";
import { UserProfileSwitcher } from "./UserProfileSwitcher";

// ============================================================================
// Page Header
// ============================================================================

interface PageHeaderProps {
  /** Boxed section glyph. Omit when `brand` is provided. */
  icon?: LucideIcon | React.FC<{ className?: string }>;
  /**
   * Brand slot rendered in place of the boxed icon (e.g. the CV Clanker text
   * wordmark). When set, the icon box is not rendered.
   */
  brand?: React.ReactNode;
  title: string;
  subtitle: string;
  /**
   * When provided, renders in place of the title/subtitle text block (the
   * brand icon stays to its left). Used to host the Swipe|Manage toggle.
   */
  titleSlot?: React.ReactNode;
  badge?: string;
  statusIndicator?: React.ReactNode;
  actions?: React.ReactNode;
  showVersionFooter?: boolean;
  navOpen?: boolean;
  onNavOpenChange?: (open: boolean) => void;
  /**
   * When true, the header content spans the full viewport width (just
   * the `px-4` side padding). Default keeps the legacy `container mx-auto`
   * cap so other pages don't shift; opt in from pages whose `<main>` also
   * goes edge-to-edge (e.g. OrchestratorPage).
   */
  fullWidth?: boolean;
  /**
   * Keep the brand/title and the actions on a single row at all widths
   * (instead of the default stack-on-mobile). Used by the mobile Swipe
   * header so the Run-pipeline button stays top-right next to the toggle.
   */
  inlineActions?: boolean;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  icon: Icon,
  brand,
  title,
  subtitle,
  titleSlot,
  badge,
  statusIndicator,
  actions,
  showVersionFooter = true,
  navOpen: controlledNavOpen,
  onNavOpenChange,
  fullWidth = false,
  inlineActions = false,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [internalNavOpen, setInternalNavOpen] = useState(false);
  const navOpen = controlledNavOpen ?? internalNavOpen;
  const setNavOpen = onNavOpenChange ?? setInternalNavOpen;
  const version = getAppVersion();

  // The switch flow's state lives HERE, not in the drawer's switcher: the
  // sheet unmounts its contents on close, and the switch must survive
  // closing the drawer to show the restart overlay and reload.
  const { switchState, activateProfile, isPending } = useProfileSwitch();

  const handleNavClick = (to: string, activePaths?: string[]) => {
    if (isNavActive(location.pathname, to, activePaths)) {
      setNavOpen(false);
      return;
    }
    setNavOpen(false);
    setTimeout(() => navigate(to), 150);
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div
        className={cn(
          "flex px-4 py-4",
          inlineActions
            ? "flex-row items-center justify-between gap-2"
            : "flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
          fullWidth ? "w-full" : "container mx-auto",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 flex flex-col">
              <SheetHeader>
                <SheetTitle>CV Clanker</SheetTitle>
                <UserProfileSwitcher
                  activateProfile={activateProfile}
                  isPending={isPending}
                  onCloseDrawer={() => setNavOpen(false)}
                />
              </SheetHeader>
              <nav className="mt-6 flex flex-col gap-2">
                {NAV_LINKS.map(({ to, label, icon: NavIcon, activePaths }) => (
                  <button
                    key={to}
                    type="button"
                    onClick={() => handleNavClick(to, activePaths)}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground text-left",
                      isNavActive(location.pathname, to, activePaths)
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <NavIcon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </nav>
              {showVersionFooter && (
                <div className="mt-auto pt-6 pb-2">
                  <div className="flex flex-col items-start gap-2">
                    <span className="text-xs text-muted-foreground">
                      Version {version}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNavOpen(false);
                        window.open("/docs", "_blank", "noopener,noreferrer");
                      }}
                      className="h-7 gap-1.5 px-2 text-xs"
                    >
                      <span>Documentation</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </SheetContent>
          </Sheet>

          {brand ? (
            brand
          ) : Icon ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
          ) : null}
          {titleSlot ?? (
            <div className="min-w-0 leading-tight">
              <div className="text-sm font-semibold tracking-tight">
                {title}
              </div>
              <div className="text-xs text-muted-foreground">{subtitle}</div>
            </div>
          )}
          {badge && (
            <Badge variant="outline" className="uppercase tracking-wide">
              {badge}
            </Badge>
          )}
          {statusIndicator}
        </div>

        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            inlineActions
              ? "w-auto flex-nowrap justify-end"
              : "w-full flex-wrap sm:w-auto sm:flex-nowrap sm:justify-end",
          )}
        >
          {actions}
        </div>
      </div>
      <ProfileSwitchOverlay state={switchState} />
    </header>
  );
};

export const StatusIndicator = StatusBadgeIndicator;

// ============================================================================
// Split Layout (List + Detail panels)
// ============================================================================

interface SplitLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  children,
  className,
}) => (
  <section
    className={cn(
      "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]",
      className,
    )}
  >
    {children}
  </section>
);

// ============================================================================
// List Panel (left side of split)
// ============================================================================

interface ListPanelProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const ListPanel: React.FC<ListPanelProps> = ({
  children,
  header,
  footer,
  className,
}) => (
  <div
    className={cn(
      "min-w-0 rounded-xl border border-border/60 bg-card/40 flex flex-col",
      className,
    )}
  >
    {header && (
      <div className="border-b border-border/60 px-4 py-3">{header}</div>
    )}
    <div className="flex-1 divide-y divide-border/60 overflow-y-auto">
      {children}
    </div>
    {footer && (
      <div className="border-t border-border/60 px-4 py-2">{footer}</div>
    )}
  </div>
);

// ============================================================================
// List Item (clickable row in list)
// ============================================================================

interface ListItemProps {
  selected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}

export const ListItem: React.FC<ListItemProps> = ({
  selected,
  onClick,
  children,
  className,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex w-full items-start gap-4 px-4 py-3 text-left transition-colors",
      selected ? "bg-muted/40" : "hover:bg-muted/30",
      className,
    )}
    aria-pressed={selected}
  >
    {children}
  </button>
);

// ============================================================================
// Detail Panel (right side of split)
// ============================================================================

interface DetailPanelProps {
  children: React.ReactNode;
  className?: string;
  sticky?: boolean;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  children,
  className,
  sticky = true,
}) => (
  <div
    className={cn(
      "min-w-0 rounded-xl border border-border/60 bg-card/40 p-4",
      sticky && "lg:sticky lg:top-24 lg:self-start",
      className,
    )}
  >
    {children}
  </div>
);

// ============================================================================
// Empty State
// ============================================================================

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
}) => (
  <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    {Icon && <Icon className="h-10 w-10 text-muted-foreground/50 mb-2" />}
    <div className="text-base font-semibold">{title}</div>
    {description && (
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
    )}
    {action && <div className="mt-2">{action}</div>}
  </div>
);

// ============================================================================
// Score Meter
// ============================================================================

interface ScoreMeterProps {
  score: number | null;
  showLabel?: boolean;
}

const getScoreTokens = (score: number) => {
  if (score >= 90) return { bar: "bg-status-good/80" };
  if (score >= 70) return { bar: "bg-status-warn/80" };
  if (score >= 50)
    return {
      bar: "bg-[color-mix(in_oklab,var(--status-warn)_50%,var(--status-bad))]/80",
    };
  return { bar: "bg-status-bad/80" };
};

export const ScoreMeter: React.FC<ScoreMeterProps> = ({
  score,
  showLabel = true,
}) => {
  if (score == null) {
    return <span className="text-xs text-muted-foreground">Not scored</span>;
  }

  const tokens = getScoreTokens(score);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="h-1.5 w-12 rounded-full bg-muted/40">
        <div
          className={cn("h-1.5 rounded-full", tokens.bar)}
          style={{ width: `${Math.max(4, Math.min(100, score))}%` }}
        />
      </div>
      {showLabel && (
        <span className="tabular-nums text-foreground">{score}%</span>
      )}
    </div>
  );
};

// ============================================================================
// Full Height Split Layout (for pages like VisaSponsors that use full viewport)
// ============================================================================

interface FullHeightSplitProps {
  sidebar: React.ReactNode;
  sidebarWidth?: string;
  children: React.ReactNode;
}

export const FullHeightSplit: React.FC<FullHeightSplitProps> = ({
  sidebar,
  sidebarWidth = "lg:w-[420px]",
  children,
}) => (
  <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
    <div
      className={cn(
        "flex w-full flex-col border-b lg:border-b-0 lg:border-r",
        sidebarWidth,
      )}
    >
      {sidebar}
    </div>
    <div className="flex-1 overflow-y-auto">{children}</div>
  </div>
);

// ============================================================================
// Section Card (for forms, stats, etc.)
// ============================================================================

interface SectionCardProps {
  children: React.ReactNode;
  className?: string;
}

export const SectionCard: React.FC<SectionCardProps> = ({
  children,
  className,
}) => (
  <section
    className={cn(
      "rounded-xl border border-border/60 bg-card/40 p-4",
      className,
    )}
  >
    {children}
  </section>
);

// ============================================================================
// Page Main Content Wrapper
// ============================================================================

interface PageMainProps {
  children: React.ReactNode;
  className?: string;
}

export const PageMain: React.FC<PageMainProps> = ({ children, className }) => (
  <main
    className={cn("container mx-auto space-y-6 px-4 py-6 pb-12", className)}
  >
    {children}
  </main>
);
