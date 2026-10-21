/**
 * Local browser notifications for new durable attention records.
 *
 * This is deliberately not Web Push: the page raises an OS notification only while the console
 * is running and backgrounded. The durable in-app notification center remains authoritative and
 * is replayed from the gateway after reconnect. Permission is requested lazily from Settings.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { serviceWorkerRegistration } from "./pwa";
import type { UserNotification } from "./types";

/** One stable key so an operator's opt-in survives restarts and the broader notification center. */
export const LOCAL_NOTIFICATION_STORAGE_KEY = "nextCoderApprovalNotifications";

/** `unsupported` is distinct from `denied`: the operator can still fix `denied` in browser settings. */
export type NotificationSupportState = "unsupported" | "default" | "granted" | "denied";

export interface LocalNotificationPayload {
  tag: string;
  title: string;
  body: string;
  url: string;
}

export interface LocalNotificationPlan {
  notifications: LocalNotificationPayload[];
  seen: string[];
}

export function readNotificationSupport(): NotificationSupportState {
  if (typeof window === "undefined") return "unsupported";
  const api = (window as { Notification?: typeof Notification }).Notification;
  if (typeof api !== "function") return "unsupported";
  const permission = api.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

export function readLocalNotificationPreference(): boolean {
  try {
    return localStorage.getItem(LOCAL_NOTIFICATION_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeLocalNotificationPreference(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(LOCAL_NOTIFICATION_STORAGE_KEY, "on");
    else localStorage.removeItem(LOCAL_NOTIFICATION_STORAGE_KEY);
  } catch {
    // Preference persistence is a convenience; the in-memory toggle still works.
  }
}

function notificationUrl(notification: UserNotification): string {
  const params = new URLSearchParams({ view: "notifications", notification: notification.id });
  if (notification.commandId) params.set("command", notification.commandId);
  if (notification.environmentId) params.set("environment", notification.environmentId);
  if (notification.threadId) params.set("thread", notification.threadId);
  return `/#activity?${params.toString()}`;
}

/**
 * Plans local OS notifications only for records first observed after the initial durable replay.
 * Existing unread records remain visible in the notification center without producing a burst on
 * page load. `seen` remains bounded while retaining ids from older pages, so loading another page
 * cannot re-announce a record that the client observed earlier.
 */
export function planLocalNotifications(options: {
  records: readonly UserNotification[];
  seen: readonly string[];
  enabled: boolean;
  permission: NotificationSupportState;
  hidden: boolean;
  initialReplay: boolean;
}): LocalNotificationPlan {
  const visible = options.records.filter((record) => !record.dismissedAt);
  const dismissed = new Set(options.records.filter((record) => record.dismissedAt).map((record) => record.id));
  const seen = [...new Set([
    ...options.seen.filter((id) => !dismissed.has(id)),
    ...visible.map((record) => record.id),
  ])].slice(-1_000);
  if (options.initialReplay) return { notifications: [], seen };
  const active = options.enabled && options.permission === "granted" && options.hidden;
  if (!active) return { notifications: [], seen };

  const previous = new Set(options.seen);
  const fresh = visible.filter((record) => !record.readAt && !previous.has(record.id));
  if (fresh.length === 0) return { notifications: [], seen };

  if (fresh.length > 2) {
    return {
      notifications: [{
        tag: "next-coder-attention",
        title: `${fresh.length} new Next Coder updates`,
        body: "Open the notification center to review them.",
        url: "/#activity?view=notifications",
      }],
      seen,
    };
  }

  return {
    notifications: fresh.map((record) => ({
      tag: `next-coder-${record.id}`,
      title: record.title,
      body: record.severity === "error"
        ? "Next Coder needs your attention."
        : record.severity === "attention"
          ? "Open Next Coder to respond."
          : "Open Next Coder for details.",
      url: notificationUrl(record),
    })),
    seen,
  };
}

export async function deliverLocalNotification(payload: LocalNotificationPayload): Promise<boolean> {
  const options: NotificationOptions = {
    body: payload.body,
    tag: payload.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    data: { url: payload.url },
  };

  // Android Chrome throws on `new Notification()`; the worker registration is the
  // supported path there and also gives us the notificationclick handler.
  const registration = await serviceWorkerRegistration();
  if (registration?.showNotification) {
    try {
      await registration.showNotification(payload.title, options);
      return true;
    } catch {
      // Fall through to the page-level constructor.
    }
  }

  try {
    const api = (window as { Notification?: typeof Notification }).Notification;
    if (typeof api !== "function") return false;
    const notification = new api(payload.title, options);
    notification.onclick = () => {
      window.focus();
      window.location.hash = payload.url.replace(/^\/?#?/, "");
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export interface LocalNotificationsController {
  localNotificationsEnabled: boolean;
  notificationSupport: NotificationSupportState;
  enableLocalNotifications: () => Promise<NotificationSupportState>;
  disableLocalNotifications: () => void;
}

export function useLocalNotifications(
  records: readonly UserNotification[],
  loaded: boolean,
): LocalNotificationsController {
  const [enabled, setEnabled] = useState(readLocalNotificationPreference);
  const [permission, setPermission] = useState<NotificationSupportState>(readNotificationSupport);
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  const seenRef = useRef<string[]>([]);
  const replaySeededRef = useRef(false);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const initialReplay = !replaySeededRef.current;
    const plan = planLocalNotifications({
      records,
      seen: seenRef.current,
      enabled,
      permission,
      hidden,
      initialReplay,
    });
    replaySeededRef.current = true;
    seenRef.current = plan.seen;
    for (const payload of plan.notifications) void deliverLocalNotification(payload);
  }, [enabled, hidden, loaded, permission, records]);

  const enableLocalNotifications = useCallback(async () => {
    const support = readNotificationSupport();
    if (support === "unsupported") {
      setPermission("unsupported");
      return "unsupported" as const;
    }
    let result: NotificationSupportState = support;
    if (support === "default") {
      try {
        const requested = await Notification.requestPermission();
        result = requested === "granted" || requested === "denied" ? requested : "default";
      } catch {
        result = "default";
      }
    }
    setPermission(result);
    const granted = result === "granted";
    setEnabled(granted);
    writeLocalNotificationPreference(granted);
    return result;
  }, []);

  const disableLocalNotifications = useCallback(() => {
    setEnabled(false);
    writeLocalNotificationPreference(false);
  }, []);

  return {
    localNotificationsEnabled: enabled && permission === "granted",
    notificationSupport: permission,
    enableLocalNotifications,
    disableLocalNotifications,
  };
}
