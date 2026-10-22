import assert from "node:assert/strict";
import test from "node:test";

import { createConvexStoreAdapter } from "../src/convexStore.mjs";
import { createEventBroker } from "../src/events.mjs";

function fakeClient() {
  return {
    query: async () => [],
    mutation: async (name, args) => {
      if (name === "gatewayStore:createDevice") return { id: "dev_1", userId: args.userId };
      if (name === "gatewayStore:authenticateDevice") return { id: "dev_1", userId: "user_owner" };
      if (name === "gatewayStore:recordDeviceHeartbeat") return { device: { id: "dev_1", userId: "user_owner" } };
      if (name === "gatewayStore:ensureUser") return { id: args.userId, email: args.email };
      if (name === "gatewayStore:authenticateUserToken") return { user: { id: "user_from_token" } };
      return { ok: true };
    },
  };
}

test("Convex mutations notify subscribers with the affected user", async () => {
  const store = createConvexStoreAdapter({ client: fakeClient(), gatewaySecret: "s" });
  const changes = [];
  store.subscribe((change) => changes.push(change));

  await store.createDevice({ userId: "user_1", label: "Controller", profile: "next-coder" });
  assert.deepEqual(changes.at(-1), { userId: "user_1", action: "createDevice" });

  await store.updateUserPrivacySettings({ userId: "user_2", mediaRetentionDays: 7 });
  assert.deepEqual(changes.at(-1), { userId: "user_2", action: "updateUserPrivacySettings" });
});

test("Convex mutations resolve the user from the result when args do not name one", async () => {
  const store = createConvexStoreAdapter({ client: fakeClient(), gatewaySecret: "s" });
  const changes = [];
  store.subscribe((change) => changes.push(change));

  await store.recordDeviceHeartbeat({ deviceId: "dev_1", status: {} });
  assert.equal(changes.at(-1).userId, "user_owner");
  changes.length = 0;
  await store.authenticateDevice("dev_1", "secret");
  await store.ensureUser({ userId: "user_3", email: "a@b.c" });
  await store.authenticateUserToken("token-secret");
  assert.deepEqual(changes, [], "auth bookkeeping must not trigger a console read/auth/refetch loop");
});

test("Convex queries never emit change notifications", async () => {
  const store = createConvexStoreAdapter({ client: fakeClient(), gatewaySecret: "s" });
  const changes = [];
  store.subscribe((change) => changes.push(change));

  await store.listDevices("user_1");
  await store.listEnvironments("user_1");
  await store.listCommands("user_1");
  assert.deepEqual(changes, []);
});

test("unsubscribing stops notifications", async () => {
  const store = createConvexStoreAdapter({ client: fakeClient(), gatewaySecret: "s" });
  const changes = [];
  const unsubscribe = store.subscribe((change) => changes.push(change));

  await store.createDevice({ userId: "user_1", label: "A", profile: "next-coder" });
  assert.equal(changes.length, 1);

  unsubscribe();
  await store.createDevice({ userId: "user_1", label: "B", profile: "next-coder" });
  assert.equal(changes.length, 1);
});

test("a throwing subscriber does not fail the store write", async () => {
  const store = createConvexStoreAdapter({ client: fakeClient(), gatewaySecret: "s" });
  store.subscribe(() => {
    throw new Error("subscriber exploded");
  });

  const result = await store.createDevice({ userId: "user_1", label: "A", profile: "next-coder" });
  assert.equal(result.device.id, "dev_1");
});

test("the broker turns a user-scoped change into a state.changed event", () => {
  const events = createEventBroker();
  const written = [];
  const res = {
    writeHead: () => {},
    write: (chunk) => written.push(chunk),
    on: () => {},
  };

  events.connect({ userId: "user_1", res });
  written.length = 0;

  events.broadcastUserChange("user_1", { action: "createDevice" });
  const body = written.join("");
  assert.match(body, /event: state\.changed/u);
  assert.match(body, /"latestAction":"createDevice"/u);

  written.length = 0;
  events.broadcastUserChange("user_other", { action: "createDevice" });
  assert.equal(written.join(""), "", "changes must not leak to another user's stream");
});

test("the broker can wake every connected user for a fleet firmware release", () => {
  const events = createEventBroker();
  const first = [];
  const second = [];
  const response = (written) => ({ writeHead: () => {}, write: (chunk) => written.push(chunk), on: () => {} });
  events.connect({ userId: "user_1", res: response(first) });
  events.connect({ userId: "user_2", res: response(second) });
  first.length = 0;
  second.length = 0;

  events.broadcastToAll("firmware.changed", { version: "0.2.0", hardwareModel: "ips28-esp32-s3r8" });
  assert.match(first.join(""), /event: firmware\.changed/u);
  assert.match(second.join(""), /"version":"0.2.0"/u);
});
