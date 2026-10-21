import {
  Bell,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  History,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Controller } from "../controller";
import { commandSummary, commandType, formatRelativeTime, renderEventResult } from "../format";
import type { Command } from "../types";
import {
  Button,
  EmptyState,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";
import "./intelligence-library.css";

type ActivityView = "notifications" | "approvals" | "commands" | "audit";

function initialActivityView(c: Controller): ActivityView {
  const query = window.location.hash.split("?", 2)[1] ?? "";
  const requested = new URLSearchParams(query).get("view");
  if (requested === "notifications" || requested === "approvals" || requested === "commands" || requested === "audit") {
    return requested;
  }
  if (c.notificationUnreadCount > 0) return "notifications";
  return c.pendingApprovals.length ? "approvals" : "commands";
}

function tone(status: string) {
  if (status === "approval_required") return "warning" as const;
  if (["failed", "rejected"].includes(status)) return "danger" as const;
  if (["completed", "approved"].includes(status)) return "success" as const;
  if (["running", "dispatched"].includes(status)) return "live" as const;
  return "neutral" as const;
}

export function ActivityPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [view, setView] = useState<ActivityView>(() => initialActivityView(c));
  const [query, setQuery] = useState("");
  const [traceOpen, setTraceOpen] = useState(false);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const source = view === "approvals" ? c.pendingApprovals : c.recentCommands;
    if (!normalized) return source;
    return source.filter((command) =>
      [command.id, command.status, command.risk, commandSummary(command), commandType(command)]
        .some((value) => String(value ?? "").toLowerCase().includes(normalized))
    );
  }, [c.pendingApprovals, c.recentCommands, query, view]);

  const decide = async (command: Command, decision: "approve" | "reject") => {
    if (decision === "reject") {
      const accepted = await confirm({
        title: "Reject this command?",
        description: commandSummary(command),
        confirmLabel: "Reject command",
      });
      if (!accepted) return;
    }
    await c.run(`${decision}-${command.id}`, `Command ${decision}d.`, async () => {
      const result = await c.api(`/v1/commands/${encodeURIComponent(command.id)}/${decision}`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const openTimeline = (command: Command) => {
    setTraceOpen(true);
    void c.run(`timeline-${command.id}`, "Timeline loaded.", () => c.loadCommandTimeline(command));
  };

  const markRead = async (id: string) => {
    await c.run(`read-notification-${id}`, "Notification marked read.", () => c.markNotificationRead(id));
  };

  const dismiss = async (id: string) => {
    await c.run(`dismiss-notification-${id}`, "Notification dismissed.", () => c.dismissNotification(id));
  };

  const openNotification = async (notification: (typeof c.notifications)[number]) => {
    if (!notification.readAt) {
      const result = await c.run(
        `open-notification-${notification.id}`,
        "Notification opened.",
        () => c.markNotificationRead(notification.id),
      );
      if (!result) return;
    }
    const command = notification.commandId
      ? c.commands.find((candidate) => candidate.id === notification.commandId)
      : null;
    if (command) {
      setView("commands");
      openTimeline(command);
      return;
    }
    if (notification.environmentId) {
      c.setSelectedEnvironmentId(notification.environmentId);
      if (notification.threadId) c.setSelectedThreadId(notification.threadId);
      window.location.hash = "operate";
    }
  };

  const scheduler = c.backgroundLiveness?.scheduledWorker ?? null;
  const schedulerTone = scheduler?.status === "healthy"
    ? "success" as const
    : scheduler?.status === "degraded" || scheduler?.status === "stale"
      ? "warning" as const
      : scheduler?.status === "unknown" || scheduler?.status === "not_configured"
        ? "neutral" as const
        : "danger" as const;

  return (
    <div
      className="activity-workspace"
      data-has-trace={c.timelineCommand ? true : undefined}
      data-trace-open={traceOpen || undefined}
    >
      <Panel elevated className="activity-list">
        <SectionHeader
          eyebrow="Audit trail"
          title="Activity and decisions"
          description="Review durable notifications, work that needs attention, command history, and account changes."
          action={
            <Button size="sm" onClick={() => void c.refreshAll()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          }
        />
        <div className="activity-list__toolbar flex flex-col gap-3 border-y border-control bg-surface-inset/45 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="intent-switcher" aria-label="Activity view">
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "notifications" || undefined}
              onClick={() => setView("notifications")}
            >
              <Bell className="size-3.5" /> Notifications
              {c.notificationUnreadCount ? <span className="nav-count nav-count--warning">{c.notificationUnreadCount}</span> : null}
            </button>
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "approvals" || undefined}
              onClick={() => setView("approvals")}
            >
              <ShieldAlert className="size-3.5" /> Approvals
              {c.pendingApprovals.length ? <span className="nav-count nav-count--warning">{c.pendingApprovals.length}</span> : null}
            </button>
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "commands" || undefined}
              onClick={() => setView("commands")}
            >
              <ListChecks className="size-3.5" /> Commands
            </button>
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "audit" || undefined}
              onClick={() => setView("audit")}
            >
              <ScrollText className="size-3.5" /> Audit
            </button>
          </div>
          {view === "approvals" || view === "commands" ? (
            <label className="relative block">
              <span className="sr-only">Filter activity</span>
              <input
                className="min-w-56 pl-3"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter commands"
              />
            </label>
          ) : null}
        </div>

        <div className="activity-list__status flex flex-wrap items-center justify-between gap-3 border-b border-control bg-surface-inset/25 px-5 py-3" aria-label="Scheduled worker health">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-ink">Scheduled background work</span>
              {scheduler ? <StatusBadge tone={schedulerTone} label={scheduler.status.replaceAll("_", " ")} /> : null}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              {c.backgroundLivenessError
                ? c.backgroundLivenessError
                : scheduler
                  ? `Last successful run ${formatRelativeTime(scheduler.lastSuccessAt)}. This is scheduler evidence, separate from connector, T3, and provider health.`
                  : "Scheduler evidence is loading. Connector, T3, and provider health are reported separately."}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void c.refreshBackgroundLiveness()}>
            <RefreshCw className="size-3.5" /> Check scheduler
          </Button>
        </div>

        <div className="activity-list__body">
          {view === "notifications" ? (
            !c.notificationsLoaded ? (
              <div className="grid min-h-full place-items-center p-8" role="status">
                <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> Loading notifications…
                </span>
              </div>
            ) : c.notificationsError && c.notifications.length === 0 ? (
              <EmptyState
                icon={WifiOff}
                title="Notifications are unavailable"
                description={`${c.notificationsError} Durable records will replay when the gateway is reachable again.`}
                action={<Button onClick={() => void c.refreshNotifications()}><RefreshCw className="size-4" /> Retry</Button>}
              />
            ) : c.notifications.length ? (
              <div>
                <div className="activity-list__strip flex flex-wrap items-center justify-between gap-3 border-b border-control px-5 py-3">
                  <p className="text-xs text-ink-muted">
                    {c.connection === "reconnecting"
                      ? "Live updates are reconnecting; durable replay remains authoritative."
                      : `${c.notificationUnreadCount} unread · retained for 30 days, up to 1,000 records.`}
                  </p>
                  {c.notificationUnreadCount ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={c.busyAction === "read-all-notifications"}
                      onClick={() => void c.run("read-all-notifications", "All notifications marked read.", c.markAllNotificationsRead)}
                    >
                      <Check className="size-3.5" /> Mark all read
                    </Button>
                  ) : null}
                </div>
                <div className="activity-list__rows">
                  {c.notifications.map((notification) => {
                    const unread = !notification.readAt;
                    const notificationTone = notification.severity === "error"
                      ? "danger" as const
                      : notification.severity === "attention" ? "warning" as const : "info" as const;
                    const environment = notification.environmentId
                      ? c.environments.find((candidate) => candidate.id === notification.environmentId)
                      : null;
                    return (
                      <article
                        key={notification.id}
                        className="activity-list__row grid gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        data-unread={unread || undefined}
                      >
                        <button
                          type="button"
                          className="min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          onClick={() => void openNotification(notification)}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            {unread ? <span className="size-2 rounded-full bg-primary" aria-label="Unread" /> : null}
                            <span className="activity-list__title font-display text-sm font-semibold">{notification.title}</span>
                            <StatusBadge tone={notificationTone} label={notification.kind.replaceAll("_", " ").replaceAll(".", " · ")} />
                          </div>
                          <p className="activity-list__meta mt-2 truncate text-xs text-ink-muted">
                            {environment?.label ?? notification.environmentId ?? "Account"}
                            {notification.threadId ? ` · thread ${notification.threadId}` : ""}
                          </p>
                          <p className="activity-list__stamp mt-2 font-mono text-[11px] text-ink-faint">
                            {formatRelativeTime(notification.createdAt)} · {unread ? "unread" : `read ${formatRelativeTime(notification.readAt)}`}
                          </p>
                        </button>
                        <div className="flex flex-wrap items-center gap-2">
                          {unread ? (
                            <Button size="sm" variant="ghost" onClick={() => void markRead(notification.id)}>
                              <Check className="size-3.5" /> Mark read
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => void dismiss(notification.id)}>
                            <Trash2 className="size-3.5" /> Dismiss
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {c.notificationsHaveMore ? (
                  <div className="border-t border-control p-4 text-center">
                    <Button onClick={() => void c.loadOlderNotifications()}>
                      <History className="size-4" /> Load older
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState
                icon={BellRing}
                title="No notifications"
                description="Completed or failed turns, decisions that need you, and connection changes will appear here and replay after reconnect."
              />
            )
          ) : view === "audit" ? (
            c.audit.length ? (
              <div className="activity-list__rows">
                {c.audit.map((event, index) => (
                  <article key={event.id ?? `${event.createdAt}-${index}`} className="activity-list__row grid grid-cols-[12px_1fr_auto] gap-3 px-5 py-4">
                    <span className="mt-1.5 size-2 rounded-full bg-accent ring-4 ring-accent/10" />
                    <div className="min-w-0">
                      <p className="activity-list__title truncate text-sm font-semibold">{event.action}</p>
                      <p className="activity-list__meta mt-1 truncate text-xs text-ink-muted">
                        {event.actorType ?? "system"} {event.actorId ?? ""} → {event.targetId ?? "account"}
                      </p>
                    </div>
                    <time className="font-mono text-[10px] text-ink-faint">{formatRelativeTime(event.createdAt)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState icon={ScrollText} title="No audit events" description="Account and device changes will be recorded here." />
            )
          ) : filteredCommands.length ? (
            <div className="activity-list__rows">
              {filteredCommands.map((command) => (
                <article key={command.id} className="activity-list__row grid gap-4 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                  <button
                    type="button"
                    className="min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => openTimeline(command)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="activity-list__title font-display text-sm font-semibold capitalize">{commandType(command)}</span>
                      <StatusBadge tone={tone(command.status)} label={command.status.replaceAll("_", " ")} />
                      <span className="text-xs font-semibold capitalize text-ink-muted">{command.risk ?? "unknown"} risk</span>
                    </div>
                    <p className="activity-list__copy mt-2 line-clamp-2 text-sm leading-relaxed text-ink-muted">{commandSummary(command)}</p>
                    <p className="activity-list__stamp mt-2 truncate font-mono text-[11px] text-ink-faint">
                      {command.id} · {command.threadId ?? "no thread"} · {formatRelativeTime(command.createdAt)}
                    </p>
                  </button>
                  <div className="flex items-center gap-2">
                    {command.status === "approval_required" ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => void decide(command, "approve")}>
                          <Check className="size-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="danger-ghost" onClick={() => void decide(command, "reject")}>
                          <X className="size-3.5" /> Reject
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openTimeline(command)}
                      >
                        Timeline <ChevronRight className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={view === "approvals" ? ShieldAlert : History}
              title={view === "approvals" ? "No pending approvals" : "No matching commands"}
              description={view === "approvals"
                ? "The queue is clear. Supervised actions will appear here and beside the Operations composer."
                : "Adjust the filter or dispatch a command from Operations."}
            />
          )}
        </div>
      </Panel>

      {c.timelineCommand ? (
        <aside
          className="activity-trace"
          aria-label="Command trace"
        >
          <Panel className="activity-trace__panel">
            <SectionHeader
              compact
              eyebrow="Command trace"
              title={commandType(c.timelineCommand)}
              action={
                <>
                  <Button
                    className="activity-trace__back"
                    size="sm"
                    variant="ghost"
                    onClick={() => setTraceOpen(false)}
                  >
                    <ChevronLeft className="size-3.5" /> Activity
                  </Button>
                  <StatusBadge tone={tone(c.timelineCommand.status)} label={c.timelineCommand.status} />
                </>
              }
            />
            <div className="activity-trace__body">
              <div className="activity-trace__transcript border-t border-control bg-console p-4 text-console-ink">
                <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {commandSummary(c.timelineCommand)}
                </p>
              </div>
              <div className="activity-trace__events">
                {c.commandEvents.length ? c.commandEvents.map((event) => (
                  <div key={event.id} className="activity-trace__event grid grid-cols-[12px_1fr] gap-3 px-4 py-4">
                    <span className="mt-1.5 size-2 rounded-full bg-primary ring-4 ring-primary/10" />
                    <div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="activity-trace__event-title text-sm font-semibold capitalize">{event.status.replaceAll("_", " ")}</p>
                        <time className="font-mono text-[10px] text-ink-faint">{formatRelativeTime(event.createdAt)}</time>
                      </div>
                      <p className="activity-list__meta mt-1 text-xs text-ink-muted">
                        {event.actorType ?? "system"}{event.actorId ? `:${event.actorId}` : ""} · from {event.previousStatus ?? "created"}
                      </p>
                      <p className="activity-list__copy mt-2 text-xs leading-relaxed text-ink-muted">{renderEventResult(event.result)}</p>
                    </div>
                  </div>
                )) : (
                  <EmptyState compact icon={Clock3} title="No transitions" description="This command has no recorded events." />
                )}
              </div>
            </div>
          </Panel>
        </aside>
      ) : null}
    </div>
  );
}
