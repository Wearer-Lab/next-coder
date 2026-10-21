import {
  Activity,
  Archive,
  Blocks,
  Boxes,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  GalleryVerticalEnd,
  Menu,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Sun,
  TerminalSquare,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";

import { connectionActivity, refreshActivity } from "./activity";
import { type ClaimLink, readClaimLink } from "./claimLink";
import { readCompanionCode } from "./companionLink";
import { connectorForEnvironment } from "./connectorHealth";
import { useController } from "./controller";
import {
  DeviceActionCluster,
  type DeviceOnboardingFlow,
  EnvironmentActionCluster,
} from "./features/FeatureActionClusters";
import { type MarketingRoute, readMarketingRoute } from "./marketingRoute";
import { ActivityOrb, NavLiquidIndicator } from "./motion";
import { useReorderable } from "./reorderable";
import { environmentScope, projectScope, threadScope } from "./resourceOrder";
import { ThreadSidebarItem } from "./ThreadSidebarItem";
import type { AuthConfig, ClerkBridge, Environment, PageId } from "./types";
import { useWorkspaceRecoveryMonitor } from "./useWorkspaceRecoveryMonitor";
import {
  Button,
  ConfirmProvider,
  IconButton,
  StatusBadge,
  Toast,
  cn,
  useConfirm,
} from "./ui";

// The shell's own half of the "intelligence design" system. Imported here so the
// stylesheet travels with the shell it dresses.
import "./intelligence-shell.css";

// Feature workspaces are deliberately route chunks. The controller and shell stay mounted while
// only the surface a user opens is downloaded and parsed; a 100 KiB device editor should not tax a
// first visit to Operations or the signed-out landing page.
const ActivityPage = lazyNamed(() => import("./features/ActivityPage"), "ActivityPage");
const ActionsPage = lazyNamed(() => import("./features/ActionsPage"), "ActionsPage");
const ClaimPage = lazyNamed(() => import("./features/ClaimPage"), "ClaimPage");
const DeveloperLandingPage = lazyNamed(() => import("./features/DeveloperLandingPage"), "DeveloperLandingPage");
const DevicesPage = lazyNamed(() => import("./features/DevicesPage"), "DevicesPage");
const EnvironmentsPage = lazyNamed(() => import("./features/EnvironmentsPage"), "EnvironmentsPage");
const HardwareLandingPage = lazyNamed(() => import("./features/HardwareLandingPage"), "HardwareLandingPage");
const LandingPage = lazyNamed(() => import("./features/LandingPage"), "LandingPage");
const MediaPage = lazyNamed(() => import("./features/MediaPage"), "MediaPage");
const OnboardingPage = lazyNamed(() => import("./features/OnboardingPage"), "OnboardingPage");
const OperatePage = lazyNamed(() => import("./features/OperatePage"), "OperatePage");
const QuickPage = lazyNamed(() => import("./features/QuickPage"), "QuickPage");
const SettingsPage = lazyNamed(() => import("./features/SettingsPage"), "SettingsPage");
const WorkspaceRecoveryDialog = lazyNamed(
  () => import("./features/WorkspaceRecoveryDialog"),
  "WorkspaceRecoveryDialog",
);

type ComponentKey<Module> = {
  [Key in keyof Module]: Module[Key] extends ComponentType<any> ? Key : never;
}[keyof Module];

function lazyNamed<Module, Name extends ComponentKey<Module>>(
  loader: () => Promise<Module>,
  name: Name,
): LazyExoticComponent<Extract<Module[Name], ComponentType<any>>> {
  return lazy(async () => ({
    default: (await loader())[name] as Extract<Module[Name], ComponentType<any>>,
  }));
}

function RouteFallback() {
  return <div className="page-route-loading" role="status">Loading workspace…</div>;
}

interface AppProps {
  authConfig: AuthConfig;
  clerk?: ClerkBridge | null;
}

interface NavItem {
  id: PageId;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  {
    id: "quick",
    label: "Dashboard",
    shortLabel: "Dashboard",
    description: "Workspace, approvals, and actions",
    icon: Zap,
  },
  {
    id: "operate",
    label: "Operations",
    shortLabel: "Operations",
    description: "Dispatch and supervise agent work",
    icon: TerminalSquare,
  },
  {
    id: "actions",
    label: "Actions",
    shortLabel: "Actions",
    description: "Author reusable prompts, commands, media, and macros",
    icon: Blocks,
  },
  {
    id: "devices",
    label: "Devices",
    shortLabel: "Devices",
    description: "Claim and configure controllers",
    icon: Boxes,
  },
  {
    id: "environments",
    label: "Environments",
    shortLabel: "T3",
    description: "Pair T3 Code workstations",
    icon: Cable,
  },
  {
    id: "media",
    label: "Media",
    shortLabel: "Media",
    description: "Capture image and audio context",
    icon: GalleryVerticalEnd,
  },
  {
    id: "activity",
    label: "Activity",
    shortLabel: "Activity",
    description: "Notifications, approvals, commands, and audit",
    icon: Activity,
  },
  {
    id: "settings",
    label: "Settings",
    shortLabel: "Settings",
    description: "Access, privacy, and diagnostics",
    icon: Settings,
  },
];

const onboardingNavItem: NavItem = {
  id: "onboarding",
  label: "Setup",
  shortLabel: "Setup",
  description: "T3, workspace, model, and controller",
  icon: Sparkles,
};

const navById = new Map(navItems.map((item) => [item.id, item]));

function nav(id: PageId): NavItem {
  const item = navById.get(id);
  if (!item) throw new Error(`Unknown navigation target: ${id}`);
  return item;
}

// The phone bar carries the five destinations a handset operator actually needs; the rest
// stay one tap away behind the slide-out sidebar so nothing here has to scroll at 375px.
const mobileNavItems: NavItem[] = [
  nav("quick"),
  nav("operate"),
  nav("activity"),
  nav("media"),
  nav("settings"),
];

function readPage(): PageId {
  const value = window.location.hash.replace(/^#\/?/, "").split("?", 1)[0] as PageId;
  return value === "onboarding" || navItems.some((item) => item.id === value) ? value : "operate";
}

function readTheme(): "light" | "dark" {
  try {
    const stored = localStorage.getItem("nextCoderTheme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall back to the user's system preference.
  }
  return "dark";
}

function readMobileViewport(): boolean {
  return window.matchMedia?.("(max-width: 820px)").matches ?? false;
}

function connectionTone(connection: string) {
  if (connection === "live") return "live" as const;
  if (connection === "connected") return "success" as const;
  if (connection === "reconnecting" || connection === "connecting") return "warning" as const;
  if (connection === "error") return "danger" as const;
  return "neutral" as const;
}

function AppContent({ authConfig, clerk = null }: AppProps) {
  const confirm = useConfirm();
  const controller = useController({ authConfig, clerk });
  const c = controller;
  const [page, setPageState] = useState<PageId>(readPage);
  const [marketingRoute, setMarketingRoute] = useState<MarketingRoute>(readMarketingRoute);
  // Read once, before anything else can rewrite the URL. A scanned QR is a one-shot arrival.
  const [claimLink, setClaimLink] = useState<ClaimLink | null>(() => readClaimLink());
  const [companionCode] = useState<string | null>(() => readCompanionCode());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(readMobileViewport);
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);
  const [deviceOnboardingFlow, setDeviceOnboardingFlow] = useState<DeviceOnboardingFlow | null>(null);
  const [environmentConnectOpen, setEnvironmentConnectOpen] = useState(false);
  const [environmentEditId, setEnvironmentEditId] = useState<string | null>(null);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  // Local to the button rather than controller state: `refreshAll` is fire-and-forget everywhere
  // else, and nothing outside this control needs to know a manual refresh is in flight.
  const [refreshing, setRefreshing] = useState(false);
  const onboardingAutoOpenedRef = useRef(false);
  // Sending the owner to the connection editor hides the modal but keeps the watch alive, so a
  // replaced credential still recovers the workspace without a second trip through the dialog.
  const [workspaceRecoveryDeferred, setWorkspaceRecoveryDeferred] = useState(false);

  const setPage = (next: PageId) => {
    setPageState(next);
    window.location.hash = next;
    setMobileMenuOpen(false);
  };

  const editEnvironmentFromSidebar = (environment: Environment) => {
    c.setSelectedEnvironmentId(environment.id);
    setEnvironmentEditId(environment.id);
    setPage("environments");
  };

  const archiveEnvironmentFromSidebar = async (environment: Environment) => {
    const accepted = await confirm({
      title: `Archive ${environment.label}?`,
      description: "This deletes its stored credential, disconnects attached devices, clears onboarding selections, disables fixed actions and macros, and moves the record to Archive.",
      confirmLabel: "Archive environment",
    });
    if (!accepted) return;
    await c.run(`archive-environment-${environment.id}`, "Environment archived and disconnected.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/archive`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const deleteEnvironmentFromSidebar = async (environment: Environment) => {
    let dependencyCount = 0;
    try {
      const preview = await c.api<{ counts: { devices: number; actions: number; macros: number; onboarding: number } }>(
        `/v1/t3/environments/${encodeURIComponent(environment.id)}/dependencies`,
      );
      dependencyCount = preview.counts.devices + preview.counts.actions + preview.counts.macros + preview.counts.onboarding;
    } catch {
      dependencyCount = 0;
    }
    const accepted = await confirm({
      title: `Remove ${environment.label}?`,
      description: "This revokes its connector and credential, disconnects attached devices, and disables fixed actions and macros. The record remains recoverable during retention.",
      confirmLabel: "Remove environment",
      ...(dependencyCount > 0 ? { requiredText: environment.label } : {}),
    });
    if (!accepted) return;
    await c.run(`delete-environment-${environment.id}`, "Environment removed. You can restore it during retention.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, {
        method: "DELETE",
        body: { confirmationLabel: environment.label },
      });
      await c.refreshAll();
      return result;
    });
  };

  useEffect(() => {
    setWorkspaceRecoveryDeferred(false);
  }, [c.workspaceRecovery]);

  const { checking: workspaceRecoveryChecking } = useWorkspaceRecoveryMonitor({
    environmentId: c.workspaceRecovery?.environmentId ?? null,
    retryable: c.workspaceRecovery?.failure.retryable ?? true,
    credentialKey: String(c.environmentCredentialEpoch),
    checkAvailability: async (environmentId) => {
      const result = await c.api<{ environment?: Environment; error?: string }>(
        `/v1/t3/environments/${encodeURIComponent(environmentId)}/check`,
        { method: "POST", body: {} },
      );
      return result.environment?.status === "reachable" && !result.error;
    },
    reloadWorkspace: async (environmentId) => {
      await c.loadSnapshot(environmentId);
    },
    onRecovered: () => {
      setPage("operate");
      c.setNotice({ tone: "success", message: "T3 Code is available. Operations reloaded." });
    },
  });

  const workspaceRecoveryOpen = Boolean(c.workspaceRecovery) && !workspaceRecoveryDeferred;

  useEffect(() => {
    const onHashChange = () => {
      setPageState(readPage());
      setMarketingRoute(readMarketingRoute());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const onChange = (event: MediaQueryListEvent) => {
      setMobileViewport(event.matches);
      if (!event.matches) setMobileMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        sidebarSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("nextCoderTheme", theme);
    } catch {
      // Theme persistence is a convenience only.
    }
  }, [theme]);

  useEffect(() => {
    if (!c.notice) return;
    const timeout = window.setTimeout(() => c.setNotice(null), 5200);
    return () => window.clearTimeout(timeout);
  }, [c.notice, c.setNotice]);

  useEffect(() => {
    // A pending claim link owns the screen; auto-opening the wizard underneath it would strand the
    // scanned code the moment the claim resolves and hands off deliberately.
    if (claimLink) return;
    if (onboardingAutoOpenedRef.current || !c.authenticated || !c.onboardingLoaded || !c.onboarding) return;
    onboardingAutoOpenedRef.current = true;
    const initialRoute = window.location.hash.replace(/^#\/?/, "");
    const shouldAutoOpen = (initialRoute === "" || initialRoute === "operate")
      && (c.onboarding.status === "not_started" || c.onboarding.status === "in_progress");
    if (shouldAutoOpen) setPage("onboarding");
  }, [c.authenticated, c.onboarding, c.onboardingLoaded, claimLink]);

  const activeNav = page === "onboarding"
    ? onboardingNavItem
    : navById.get(page) ?? nav("operate");
  const normalizedSidebarQuery = sidebarQuery.trim().toLowerCase();
  const reorderable = useReorderable({
    onReorder: c.reorderResources,
    onNudge: c.nudgeResource,
  });
  // Reordering is disabled while the tree is filtered. A drag inside a search result would record
  // an arrangement of the matches alone, and everything hidden by the query would come back
  // unplaced — so the answer is to arrange the whole list, not the visible slice of it.
  const canReorder = !normalizedSidebarQuery;
  // Always the *unfiltered* siblings: these are the ids an arrangement is written against.
  const environmentIds = c.environments.map((environment) => environment.id);
  const projectIds = c.projects.map((project) => project.id);
  const ungroupedThreadIds = c.threads
    .filter((thread) => !thread.projectId)
    .map((thread) => thread.id);
  const visibleEnvironments = c.environments.filter((environment) =>
    !normalizedSidebarQuery || environment.label.toLowerCase().includes(normalizedSidebarQuery)
  );
  const visibleArchivedEnvironments = c.archivedEnvironments.filter((environment) =>
    !normalizedSidebarQuery || environment.label.toLowerCase().includes(normalizedSidebarQuery)
  );
  const visibleProjects = c.projects.filter((project) => {
    const label = project.title ?? project.name ?? project.workspaceRoot ?? project.id;
    return !normalizedSidebarQuery
      || label.toLowerCase().includes(normalizedSidebarQuery)
      || c.threads.some((thread) =>
        thread.projectId === project.id && thread.label.toLowerCase().includes(normalizedSidebarQuery)
      );
  });
  const ungroupedThreads = c.threads.filter((thread) =>
    !thread.projectId
    && (!normalizedSidebarQuery || thread.label.toLowerCase().includes(normalizedSidebarQuery))
  );
  const activeThread = c.threads.find((thread) => thread.id === c.selectedThreadId);
  const topbarTitle = page === "operate"
    ? activeThread?.label ?? (c.selectedEnvironment ? "No active thread" : "No environment selected")
    : activeNav.label;
  const topbarContext = page === "operate"
    ? c.selectedEnvironment?.label ?? "Select a T3 environment"
    : activeNav.description;
  const counts: Record<PageId, number> = {
    quick: c.pendingApprovals.length,
    operate: c.pendingApprovals.length,
    actions: (c.actions ?? []).length,
    devices: c.devices.length,
    environments: c.environments.length,
    media: c.media.length,
    // Approval holds also produce durable notifications. Use the larger attention set instead of
    // double-counting the same blocked command in both projections.
    activity: Math.max(c.notificationUnreadCount, c.pendingApprovals.length),
    settings: 0,
    onboarding: 0,
  };
  const pageContent = useMemo(() => {
    switch (page) {
      case "quick":
        return <QuickPage controller={controller} onNavigate={setPage} />;
      case "devices":
        return (
          <DevicesPage
            controller={controller}
            onboardingFlow={deviceOnboardingFlow}
            onOnboardingFlowChange={setDeviceOnboardingFlow}
          />
        );
      case "actions":
        return <ActionsPage controller={controller} />;
      case "environments":
        return (
          <EnvironmentsPage
            controller={controller}
            connectOpen={environmentConnectOpen}
            onConnectOpenChange={setEnvironmentConnectOpen}
            editEnvironmentId={environmentEditId}
            onEditEnvironmentHandled={() => setEnvironmentEditId(null)}
          />
        );
      case "media":
        return <MediaPage controller={controller} companionCode={companionCode} />;
      case "activity":
        return <ActivityPage controller={controller} />;
      case "settings":
        return <SettingsPage controller={controller} />;
      case "onboarding":
        return <OnboardingPage controller={controller} onNavigate={setPage} />;
      default:
        return <OperatePage controller={controller} />;
    }
  }, [companionCode, controller, deviceOnboardingFlow, environmentConnectOpen, environmentEditId, page]);

  if (claimLink) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <ClaimPage
          controller={controller}
          link={claimLink}
          onDone={async ({ device }) => {
          setClaimLink(null);
          if (!device) {
            setPage("devices");
            return;
          }
          await c.refreshAll();
          c.setSelectedDeviceId(device.id);
          // A claimed controller still has to be pointed at an environment and thread. Land on the
          // wizard's device step when setup is unfinished; otherwise Devices is the right home.
          const setupIncomplete = c.onboarding && c.onboarding.status !== "completed";
          if (setupIncomplete) {
            await c.saveOnboarding({
              status: "in_progress",
              currentStep: "device",
              device: { mode: "claim", deviceId: device.id, credentialConfirmed: false },
            });
            setPage("onboarding");
          } else {
            setPage("devices");
          }
          }}
        />
      </Suspense>
    );
  }

  // A signed-out visitor gets the front door, not an empty app shell. Ordered after the claim
  // branch: a scanned QR has its own signed-out screen that keeps the code in hand through sign-in.
  if (!c.authenticated) {
    // `authenticated` is false both for "signed out" and for "Clerk has not answered yet". Showing
    // the landing page during the second would flash a marketing page at a returning user, so an
    // unresolved session gets a neutral hold instead.
    if (authConfig.clerk?.enabled && clerk && !clerk.loaded) {
      return <div className="landing landing--resolving" role="status" aria-label="Restoring your session" />;
    }
    if (marketingRoute === "developers") {
      return <Suspense fallback={<RouteFallback />}><DeveloperLandingPage authConfig={authConfig} clerk={clerk} /></Suspense>;
    }
    if (marketingRoute === "early-access") {
      return <Suspense fallback={<RouteFallback />}><HardwareLandingPage authConfig={authConfig} clerk={clerk} /></Suspense>;
    }
    return <Suspense fallback={<RouteFallback />}><LandingPage authConfig={authConfig} clerk={clerk} /></Suspense>;
  }

  return (
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed || undefined}>
      <aside
        className={cn("sidebar", mobileMenuOpen && "sidebar--mobile-open")}
        aria-label="Primary navigation"
        aria-hidden={mobileViewport && !mobileMenuOpen ? true : undefined}
        inert={mobileViewport && !mobileMenuOpen ? true : undefined}
      >
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true">
            <TerminalSquare className="size-4" />
          </div>
          <div className="brand-copy">
            <p className="brand-copy__name">Next Coder</p>
            <p className="brand-copy__meta">NIGHTLY</p>
          </div>
          {mobileViewport ? (
            <IconButton
              className="mobile-menu-close"
              variant="ghost"
              icon={X}
              label="Close navigation"
              onClick={() => setMobileMenuOpen(false)}
            />
          ) : (
            <IconButton
              className="sidebar-brand-collapse"
              variant="ghost"
              icon={sidebarCollapsed ? ChevronRight : ChevronLeft}
              label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setSidebarCollapsed((value) => !value)}
            />
          )}
        </div>

        <div className="sidebar-search">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            ref={sidebarSearchRef}
            type="search"
            value={sidebarQuery}
            onChange={(event) => setSidebarQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search environments and projects"
          />
          <kbd>⌘K</kbd>
        </div>

        <nav className="sidebar__nav">
          <div className="sidebar__section-heading">
            <span>Workspace</span>
          </div>
          {c.onboardingLoaded && c.onboarding?.status !== "completed" ? (
            <button
              type="button"
              className="nav-item"
              data-active={page === "onboarding" || undefined}
              onClick={() => setPage("onboarding")}
              aria-current={page === "onboarding" ? "page" : undefined}
              title={sidebarCollapsed ? "Setup" : undefined}
            >
              <Sparkles className="nav-item__icon" />
              <span className="nav-item__copy">
                <span className="nav-item__label">Finish setup</span>
              </span>
              <span className="resource-row__status resource-row__status--live" aria-label="Setup incomplete" />
            </button>
          ) : null}
          {[nav("quick"), nav("operate"), nav("actions"), nav("activity")].map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                data-active={active || undefined}
                onClick={() => setPage(item.id)}
                aria-current={active ? "page" : undefined}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon className="nav-item__icon" />
                <span className="nav-item__copy">
                  <span className="nav-item__label">{item.label}</span>
                </span>
                {count ? (
                  <span className={cn("nav-count", item.id === "activity" || item.id === "operate" ? "nav-count--warning" : "")}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}

          <div className="sidebar__section-heading sidebar__section-heading--resources">
            <span>Environments</span>
            <span className="sidebar__section-actions">
              <button
                type="button"
                aria-label="Refresh environments"
                title="Refresh environments"
                disabled={!c.authenticated}
                onClick={() => void c.refreshAll()}
              >
                <ChevronsUpDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Add environment"
                title="Add environment"
                onClick={() => {
                  setPage("environments");
                  setEnvironmentConnectOpen(true);
                }}
              >
                <Plus className="size-3.5" />
              </button>
            </span>
          </div>

          <div className="resource-tree">
            {visibleEnvironments.length ? visibleEnvironments.map((environment) => {
              const selected = environment.id === c.selectedEnvironmentId;
              return (
                <div
                  key={environment.id}
                  className="resource-group"
                  {...reorderable.rowProps({
                    scope: environmentScope(),
                    id: environment.id,
                    ids: environmentIds,
                    label: environment.label,
                    enabled: canReorder,
                  })}
                >
                  <div className="resource-row-shell">
                    <button
                      type="button"
                      className="resource-row resource-row--environment"
                      data-active={selected || undefined}
                      onClick={() => {
                        c.setSelectedEnvironmentId(environment.id);
                        setPage("operate");
                      }}
                    >
                      <ChevronDown className={cn("resource-row__chevron", !selected && "-rotate-90")} />
                      <Server className="resource-row__icon" />
                      <span className="resource-row__label">{environment.label}</span>
                      <span
                        className={cn(
                          "resource-row__status",
                          environment.status === "reachable" && "resource-row__status--live",
                          (environment.status === "unreachable" || environment.status === "token_expired")
                            && "resource-row__status--danger",
                        )}
                        title={environment.status ?? "unknown"}
                        role="img"
                        aria-label={`Environment status: ${environment.status ?? "unknown"}`}
                      />
                    </button>
                    <span className="resource-row-inline-actions" role="group" aria-label={`${environment.label} actions`}>
                      <button
                        type="button"
                        aria-label={`Edit ${environment.label}`}
                        title="Edit environment"
                        onClick={(event) => {
                          event.stopPropagation();
                          editEnvironmentFromSidebar(environment);
                        }}
                      ><Pencil className="size-3" /></button>
                      <button
                        type="button"
                        aria-label={`Archive ${environment.label}`}
                        title="Archive environment"
                        onClick={(event) => {
                          event.stopPropagation();
                          void archiveEnvironmentFromSidebar(environment);
                        }}
                      ><Archive className="size-3" /></button>
                      <button
                        type="button"
                        className="resource-row-inline-actions__danger"
                        aria-label={`Delete ${environment.label}`}
                        title="Delete environment"
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteEnvironmentFromSidebar(environment);
                        }}
                      ><Trash2 className="size-3" /></button>
                    </span>
                  </div>

                  {selected ? (
                    <div className="resource-children">
                      {visibleProjects.length ? visibleProjects.map((project) => {
                        const projectLabel = project.title ?? project.name ?? project.workspaceRoot ?? project.id;
                        const projectMatches = projectLabel.toLowerCase().includes(normalizedSidebarQuery);
                        const projectThreads = c.threads.filter((thread) =>
                          thread.projectId === project.id
                          && (!normalizedSidebarQuery
                            || projectMatches
                            || thread.label.toLowerCase().includes(normalizedSidebarQuery))
                        );
                        const projectThreadIds = c.threads
                          .filter((thread) => thread.projectId === project.id)
                          .map((thread) => thread.id);
                        return (
                          <div
                            key={project.id}
                            className="resource-project"
                            {...reorderable.rowProps({
                              scope: projectScope(environment.id),
                              id: project.id,
                              ids: projectIds,
                              label: projectLabel,
                              enabled: canReorder,
                            })}
                          >
                            <button
                              type="button"
                              className="resource-row resource-row--project"
                              data-active={project.id === c.selectedProjectId || undefined}
                              onClick={() => {
                                c.setSelectedProjectId(project.id);
                                setPage("operate");
                              }}
                            >
                              <Folder className="resource-row__icon" />
                              <span className="resource-row__label">{projectLabel}</span>
                            </button>
                            {projectThreads.map((thread) => (
                              <ThreadSidebarItem
                                key={thread.id}
                                thread={thread}
                                active={thread.id === c.selectedThreadId}
                                status={thread.status}
                                rowProps={reorderable.rowProps({
                                  scope: threadScope(project.id),
                                  id: thread.id,
                                  ids: projectThreadIds,
                                  label: thread.label,
                                  enabled: canReorder,
                                })}
                                onSelect={() => {
                                  c.setSelectedProjectId(project.id);
                                  c.setSelectedThreadId(thread.id);
                                  setPage("operate");
                                }}
                                onRename={async (title) => Boolean(await c.run(
                                  `rename-thread-${thread.id}`,
                                  "Thread renamed.",
                                  () => c.renameThread(thread.id, title),
                                ))}
                                onArchive={async () => Boolean(await c.run(
                                  `archive-thread-${thread.id}`,
                                  "Thread archived.",
                                  () => c.archiveThread(thread.id),
                                ))}
                                onDelete={async () => Boolean(await c.run(
                                  `delete-thread-${thread.id}`,
                                  "Thread deleted.",
                                  () => c.deleteThread(thread.id),
                                ))}
                              />
                            ))}
                          </div>
                        );
                      }) : ungroupedThreads.length ? ungroupedThreads.map((thread) => (
                        <ThreadSidebarItem
                          key={thread.id}
                          thread={thread}
                          active={thread.id === c.selectedThreadId}
                          status={thread.status}
                          rowProps={reorderable.rowProps({
                            scope: threadScope(null),
                            id: thread.id,
                            ids: ungroupedThreadIds,
                            label: thread.label,
                            enabled: canReorder,
                          })}
                          onSelect={() => {
                            c.setSelectedThreadId(thread.id);
                            setPage("operate");
                          }}
                          onRename={async (title) => Boolean(await c.run(
                            `rename-thread-${thread.id}`,
                            "Thread renamed.",
                            () => c.renameThread(thread.id, title),
                          ))}
                          onArchive={async () => Boolean(await c.run(
                            `archive-thread-${thread.id}`,
                            "Thread archived.",
                            () => c.archiveThread(thread.id),
                          ))}
                          onDelete={async () => Boolean(await c.run(
                            `delete-thread-${thread.id}`,
                            "Thread deleted.",
                            () => c.deleteThread(thread.id),
                          ))}
                        />
                      )) : (
                        <button
                          type="button"
                          className="resource-empty"
                          onClick={() => setPage("operate")}
                        >
                          No threads yet
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <button
                type="button"
                className="resource-empty resource-empty--root"
                onClick={() => {
                  setPage("environments");
                  if (!normalizedSidebarQuery) setEnvironmentConnectOpen(true);
                }}
              >
                <Plus className="size-3.5" />
                {normalizedSidebarQuery ? "No matching environments" : "Connect an environment"}
              </button>
            )}
          </div>

          {visibleArchivedEnvironments.length ? (
            <>
              <div className="sidebar__section-heading sidebar__section-heading--archive">
                <span>Archive</span>
                <span className="nav-count">{visibleArchivedEnvironments.length}</span>
              </div>
              <div className="resource-tree resource-tree--archive">
                {visibleArchivedEnvironments.map((environment) => (
                  <button
                    key={environment.id}
                    type="button"
                    className="resource-row resource-row--archived"
                    title={`${environment.label} · fully disconnected`}
                    onClick={() => setPage("environments")}
                  >
                    <Archive className="resource-row__icon" />
                    <span className="resource-row__label">{environment.label}</span>
                    <span className="resource-row__status" role="img" aria-label="Environment archived" />
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="sidebar__section-heading sidebar__section-heading--control">
            <span>Control plane</span>
          </div>
          {[nav("devices"), nav("environments"), nav("media")].map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                data-active={active || undefined}
                onClick={() => setPage(item.id)}
                aria-current={active ? "page" : undefined}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon className="nav-item__icon" />
                <span className="nav-item__copy">
                  <span className="nav-item__label">{item.label}</span>
                </span>
                {count ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className="account-chip"
            onClick={() => setPage("settings")}
            aria-label="Open settings"
            title={sidebarCollapsed ? "Settings" : undefined}
          >
            <Settings className="size-4 shrink-0" />
            <span className="account-chip__copy">
              <span className="truncate text-sm font-medium">Settings</span>
              <span className="truncate text-[10px] text-sidebar-muted">
                {clerk?.userLabel ?? (c.authenticated ? "Authenticated user" : "Not signed in")}
              </span>
            </span>
          </button>
        </div>
      </aside>

      {mobileMenuOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      <div className="workspace" inert={mobileViewport && mobileMenuOpen ? true : undefined}>
        <header className="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton
              className="mobile-menu-trigger topbar-icon-button"
              variant="ghost"
              icon={Menu}
              label="Open navigation"
              onClick={() => setMobileMenuOpen(true)}
            />
            <div className="min-w-0">
              <div className="topbar__title-line">
                <h1 className="ac-display-title truncate">{topbarTitle}</h1>
                <span className="ac-pill topbar__context">{topbarContext}</span>
              </div>
            </div>
          </div>
          <div className="topbar__actions">
            {!c.authenticated ? (
              <Button
                size="sm"
                onClick={() => {
                  if (clerk) clerk.openSignIn();
                  else setPage("settings");
                }}
              >
                Sign in
              </Button>
            ) : null}
            {page === "devices" ? (
              <DeviceActionCluster
                className="devices-topbar-actions"
                onOpen={(flow) => setDeviceOnboardingFlow(flow)}
              />
            ) : page === "environments" ? (
              <EnvironmentActionCluster
                className="environments-topbar-actions"
                onConnect={() => setEnvironmentConnectOpen(true)}
              />
            ) : page !== "onboarding" ? (
              <Button
                className="topbar-add-action hidden sm:inline-flex"
                size="sm"
                onClick={() => setPage("actions")}
              >
                <Plus className="size-4" /> Add action
              </Button>
            ) : null}
            {c.authenticated ? (
              <>
                <ActivityOrb activity={connectionActivity(c.connection)} />
                <StatusBadge
                  className="hidden sm:inline-flex"
                  tone={connectionTone(c.connection)}
                  label={c.connection}
                />
              </>
            ) : null}
            <Button
              className="topbar-icon-button"
              variant="ghost"
              size="icon"
              aria-label="Refresh gateway data"
              title="Refresh gateway data"
              disabled={!c.authenticated || refreshing}
              onClick={() => {
                setRefreshing(true);
                void c.refreshAll().finally(() => setRefreshing(false));
              }}
            >
              {refreshing
                ? <ActivityOrb activity={refreshActivity(true)} />
                : <RefreshCw className="size-4" aria-hidden="true" />}
            </Button>
            <IconButton
              className="topbar-icon-button"
              variant="ghost"
              icon={theme === "dark" ? Sun : Moon}
              label={theme === "dark" ? "Use light theme" : "Use dark theme"}
              onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            />
          </div>
        </header>

        <main className="workspace__content" id="main-content" data-page={page}>
          <Suspense fallback={<RouteFallback />}>{pageContent}</Suspense>
        </main>
      </div>

      <nav
        ref={mobileNavRef}
        className="mobile-nav"
        aria-label="Mobile navigation"
        inert={mobileViewport && mobileMenuOpen ? true : undefined}
      >
        <NavLiquidIndicator containerRef={mobileNavRef} activeKey={page} />
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <span className="relative">
                <Icon className="size-4.5" />
                {counts[item.id] ? <span className="mobile-nav__dot" /> : null}
              </span>
              <span>{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {c.notice && !workspaceRecoveryOpen ? (
        <Toast tone={c.notice.tone} onDismiss={() => c.setNotice(null)}>
          {c.notice.message}
        </Toast>
      ) : null}

      {workspaceRecoveryOpen ? <Suspense fallback={null}><WorkspaceRecoveryDialog
        open
        failure={c.workspaceRecovery?.failure ?? null}
        environment={c.environments.find((environment) => environment.id === c.workspaceRecovery?.environmentId) ?? null}
        connector={connectorForEnvironment(
          c.connectors,
          c.environments.find((environment) => environment.id === c.workspaceRecovery?.environmentId),
        )}
        retrying={c.busyAction === "retry-workspace-snapshot"}
        checking={workspaceRecoveryChecking}
        onClose={c.dismissWorkspaceRecovery}
        onOpenEnvironments={() => {
          setWorkspaceRecoveryDeferred(true);
          setPage("environments");
        }}
        onRetry={() => {
          const environmentId = c.workspaceRecovery?.environmentId;
          if (!environmentId) return;
          c.dismissWorkspaceRecovery();
          void c.run(
            "retry-workspace-snapshot",
            "T3 workspace loaded.",
            () => c.loadSnapshot(environmentId),
          );
        }}
      /></Suspense> : null}
    </div>
  );
}

export default function App(props: AppProps) {
  return (
    <ConfirmProvider>
      <AppContent {...props} />
    </ConfirmProvider>
  );
}
