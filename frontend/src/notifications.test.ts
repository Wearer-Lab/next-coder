import {
  planLocalNotifications,
  readLocalNotificationPreference,
  writeLocalNotificationPreference,
} from "./notifications";
import type { UserNotification } from "./types";

function record(id: string, overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id,
    kind: "turn.completed",
    severity: "info",
    title: "Agent turn completed",
    environmentId: "env_1",
    threadId: "thread_1",
    commandId: "cmd_1",
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    cursor: id,
    ...overrides,
  };
}

describe("local notification preference", () => {
  test("round-trips through localStorage and defaults to off", () => {
    localStorage.clear();
    expect(readLocalNotificationPreference()).toBe(false);

    writeLocalNotificationPreference(true);
    expect(readLocalNotificationPreference()).toBe(true);

    writeLocalNotificationPreference(false);
    expect(readLocalNotificationPreference()).toBe(false);
  });
});

describe("durable notification planning", () => {
  test("seeds the initial durable replay without raising a local OS notification", () => {
    const result = planLocalNotifications({
      records: [record("notification_1")],
      seen: [],
      enabled: true,
      permission: "granted",
      hidden: true,
      initialReplay: true,
    });

    expect(result.notifications).toEqual([]);
    expect(result.seen).toEqual(["notification_1"]);
  });

  test("announces only a fresh unread record while the opted-in console is backgrounded", () => {
    const result = planLocalNotifications({
      records: [record("notification_2", { kind: "turn.failed", severity: "error", title: "Agent turn failed" })],
      seen: ["notification_1"],
      enabled: true,
      permission: "granted",
      hidden: true,
      initialReplay: false,
    });

    expect(result.notifications).toEqual([expect.objectContaining({
      title: "Agent turn failed",
      body: "Next Coder needs your attention.",
      url: expect.stringContaining("view=notifications"),
    })]);
  });

  test("does not announce read or dismissed records and keeps the seen set bounded", () => {
    const result = planLocalNotifications({
      records: [
        record("read", { readAt: "2026-08-27T10:00:00.000Z" }),
        record("dismissed", { dismissedAt: "2026-08-27T10:00:00.000Z" }),
      ],
      seen: ["old", "dismissed"],
      enabled: true,
      permission: "granted",
      hidden: true,
      initialReplay: false,
    });

    expect(result.notifications).toEqual([]);
    expect(result.seen).toEqual(["old", "read"]);
  });
});
