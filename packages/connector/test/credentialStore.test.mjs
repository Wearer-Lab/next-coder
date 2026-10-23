import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main as realMain } from "../src/cli.mjs";
import { loadState, removeState, saveRuntimeState, saveState, STATE_VERSION } from "../src/config.mjs";
import { CREDENTIAL_SERVICE, createCredentialStore, credentialAccounts, LEGACY_CREDENTIAL_SERVICE, runCredentialCommand } from "../src/credentialStore.mjs";

const sample = {
  version: STATE_VERSION,
  server: "https://controller.example",
  connectorId: "con_native",
  environmentId: "env_native",
  secret: "standing-secret",
  t3BaseUrl: "http://127.0.0.1:3773",
  t3AccessToken: "t3-token-stays-in-private-state",
};

test("macOS Keychain adapter uses exact namespace, stdin, and argument arrays", async () => {
  const calls = [];
  const values = new Map();
  const run = async (file, args, options) => {
    calls.push({ file, args, input: options.input });
    assert.equal(args.includes("standing-secret"), false);
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "-i") {
      const command = options.input.match(/^add-generic-password -a "([^"]+)" -s (\S+) -U -X ([a-f0-9]+)\n$/);
      assert.ok(command);
      values.set(command[1], Buffer.from(command[3], "hex").toString("utf8"));
      return ok();
    }
    if (args[0] === "find-generic-password") return values.has(account) ? ok(`${values.get(account)}\n`) : { code: 44, stdout: "", stderr: "The specified item could not be found." };
    values.delete(account); return ok();
  };
  const store = await createCredentialStore({ platform: "darwin", fs: { access: async () => {} }, run });
  await store.write("account:one", "standing-secret");
  assert.equal(await store.read("account:one"), "standing-secret");
  await store.delete("account:one");
  assert.equal(store.backend, "macos-keychain");
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls[0].input, `add-generic-password -a "account:one" -s ${CREDENTIAL_SERVICE} -U -X ${Buffer.from("standing-secret").toString("hex")}\n`);
});

test("Linux Secret Service adapter requires a session and never places the secret in argv", async () => {
  const calls = [];
  const values = new Map();
  const run = async (file, args, options) => {
    calls.push({ file, args, input: options.input });
    assert.equal(args.includes("linux-secret"), false);
    const account = args.at(-1);
    if (args[0] === "store") { values.set(account, options.input); return ok(); }
    if (args[0] === "lookup") return values.has(account) ? ok(values.get(account)) : { code: 1, stdout: "", stderr: "" };
    values.delete(account); return ok();
  };
  const unavailable = await createCredentialStore({ platform: "linux", env: {}, findExecutable: async () => "/usr/bin/secret-tool" });
  assert.deepEqual({ backend: unavailable.backend, native: unavailable.native }, { backend: "private-file", native: false });
  const store = await createCredentialStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" }, findExecutable: async () => "/usr/bin/secret-tool", run });
  await store.write("account:linux", "linux-secret");
  assert.equal(await store.read("account:linux"), "linux-secret");
  await store.delete("account:linux");
  assert.equal(calls[0].file, "/usr/bin/secret-tool");
  assert.equal(calls[0].input, "linux-secret");
});

test("Windows Credential Manager adapter passes only metadata in environment and secret on stdin", async () => {
  const calls = [];
  let value = null;
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(args.includes("windows-secret"), false);
    assert.equal(Object.values(options.env).includes("windows-secret"), false);
    const operation = options.env.NEXT_CODER_CREDENTIAL_OPERATION;
    if (operation === "write") { value = options.input; return ok(); }
    if (operation === "read") return value == null ? { code: 1, stdout: "", stderr: "" } : ok(Buffer.from(value).toString("base64"));
    value = null; return ok();
  };
  const store = await createCredentialStore({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, fs: { access: async () => {} }, run });
  await store.write("account:windows", "windows-secret");
  assert.equal(await store.read("account:windows"), "windows-secret");
  await store.delete("account:windows");
  assert.match(calls[0].file, /powershell\.exe$/i);
  assert.deepEqual(calls[0].args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
  assert.equal(calls[0].options.input, "windows-secret");
});

test("a credential stored under the legacy service name is still readable", async () => {
  const values = new Map();
  const key = (args) => `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
  const run = async (file, args, options) => {
    if (args[0] === "-i") {
      const command = options.input.match(/^add-generic-password -a "([^"]+)" -s (\S+) -U -X ([a-f0-9]+)\n$/);
      assert.ok(command);
      values.set(`${command[2]}/${command[1]}`, Buffer.from(command[3], "hex").toString("utf8"));
      return ok();
    }
    if (args[0] === "find-generic-password") return values.has(key(args)) ? ok(`${values.get(key(args))}\n`) : { code: 44, stdout: "", stderr: "The specified item could not be found." };
    values.delete(key(args));
    return ok();
  };
  const store = await createCredentialStore({ platform: "darwin", fs: { access: async () => {} }, run });
  values.set(`${LEGACY_CREDENTIAL_SERVICE}/account:one`, "standing-secret");
  assert.equal(await store.read("account:one"), "standing-secret");
  await store.write("account:one", "rotated-secret");
  assert.equal(values.get(`${CREDENTIAL_SERVICE}/account:one`), "rotated-secret");
  await store.delete("account:one");
  assert.equal(values.size, 0);
});

test("credential subprocess failures, output limits, and timeouts never expose stdin", async () => {
  const secret = "never-print-this-standing-secret";
  await assert.rejects(
    runCredentialCommand(process.execPath, ["-e", "let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{process.stderr.write(v);process.exit(2)})"], { input: secret }),
    (error) => error.code === "CREDENTIAL_STORE_OPERATION" && !error.message.includes(secret),
  );
  await assert.rejects(
    runCredentialCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024))"], { maxOutputBytes: 32 }),
    { code: "CREDENTIAL_COMMAND_OUTPUT" },
  );
  await assert.rejects(
    runCredentialCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }),
    { code: "CREDENTIAL_STORE_TIMEOUT" },
  );
});

test("plaintext state migrates atomically and native rotation secrets never enter JSON", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-migrate-"));
  const store = memoryStore();
  await saveState(stateDir, sample);
  const hydrated = await loadState(stateDir, { credentialStore: store, requireSecure: true });
  assert.equal(hydrated.secret, sample.secret);
  let raw = await readFile(join(stateDir, "connector.json"), "utf8");
  assert.equal(raw.includes(sample.secret), false);
  assert.equal(raw.includes("macos-keychain"), true);
  const staged = { ...hydrated, credentialRotation: { id: "rot_1", pendingSecret: "next-secret", phase: "staged", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  await saveState(stateDir, staged, { credentialStore: store });
  raw = await readFile(join(stateDir, "connector.json"), "utf8");
  assert.equal(raw.includes("next-secret"), false);
  assert.equal((await loadState(stateDir, { credentialStore: store })).credentialRotation.pendingSecret, "next-secret");
  const promoted = { ...staged, secret: "next-secret", credentialRotation: { ...staged.credentialRotation, phase: "activated" } };
  await saveState(stateDir, promoted, { credentialStore: store });
  await saveState(stateDir, { ...promoted, credentialRotation: undefined }, { credentialStore: store });
  assert.equal((await loadState(stateDir, { credentialStore: store })).secret, "next-secret");
  assert.equal([...store.values.values()].includes(sample.secret), false);
  assert.equal([...store.values.values()].includes("next-secret"), true);
});

test("migration failure leaves the restricted plaintext state intact and never downgrades silently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-failure-"));
  await saveState(stateDir, sample);
  const failing = memoryStore({ failWrite: true });
  await assert.rejects(loadState(stateDir, { credentialStore: failing }), { code: "CREDENTIAL_STORE_OPERATION" });
  assert.equal(JSON.parse(await readFile(join(stateDir, "connector.json"), "utf8")).secret, sample.secret);
  const missing = memoryStore();
  missing.backend = "linux-secret-service";
  const native = memoryStore();
  await loadState(stateDir, { credentialStore: native });
  await assert.rejects(loadState(stateDir, { credentialStore: missing }), { code: "CREDENTIAL_STORE_UNAVAILABLE" });
});

test("post-commit cleanup failure leaves the newly pointed-to credential readable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-cleanup-"));
  const store = memoryStore();
  await saveState(stateDir, sample, { credentialStore: store });
  store.failDelete = true;
  await assert.rejects(saveState(stateDir, { ...sample, secret: "replacement-secret" }, { credentialStore: store }), { code: "CREDENTIAL_STORE_OPERATION" });
  store.failDelete = false;
  assert.equal((await loadState(stateDir, { credentialStore: store })).secret, "replacement-secret");
  await saveState(stateDir, { ...sample, secret: "replacement-secret" }, { credentialStore: store });
  assert.equal(store.values.size, 1);
});

test("stale service runtime persistence cannot overwrite a rotation journal or credential pointer", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-runtime-race-"));
  const store = memoryStore();
  await saveState(stateDir, sample, { credentialStore: store });
  const staleServiceState = { ...sample, lastConnectedAt: new Date().toISOString(), completedRequests: [] };
  await saveRuntimeState(stateDir, staleServiceState);
  const authoritative = await loadState(stateDir, { credentialStore: store });
  await saveState(stateDir, {
    ...authoritative,
    credentialRotation: { id: "rot_race", pendingSecret: "race-next-secret", phase: "staged", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  }, { credentialStore: store });
  staleServiceState.lastConnectionAttemptAt = new Date().toISOString();
  staleServiceState.lastConnectionError = { code: "CLOUD_SOCKET_CLOSED", message: "closed during handoff" };
  await saveRuntimeState(stateDir, staleServiceState);
  const reloaded = await loadState(stateDir, { credentialStore: store });
  assert.equal(reloaded.secret, sample.secret);
  assert.equal(reloaded.credentialRotation.pendingSecret, "race-next-secret");
  assert.equal(reloaded.lastConnectionError.code, "CLOUD_SOCKET_CLOSED");
  const runtimeRaw = await readFile(join(stateDir, "connector-runtime.json"), "utf8");
  assert.equal(runtimeRaw.includes(sample.secret), false);
  assert.equal(runtimeRaw.includes("race-next-secret"), false);
});

test("disconnect deletes pending, inactive, and active native entries before state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-remove-"));
  const store = memoryStore();
  await saveState(stateDir, sample, { credentialStore: store });
  const accounts = credentialAccounts(stateDir, sample.connectorId, "rot_unused");
  store.values.set(accounts.primaryB, "orphan-from-interrupted-write");
  await removeState(stateDir, { credentialStore: store });
  assert.equal(store.values.size, 0);
  assert.equal(await loadState(stateDir, { credentialStore: store }), null);
});

test("status reports native protection without values and disconnect removes the native credential", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-native-cli-"));
  const stateDir = join(scratch, "state");
  const store = memoryStore();
  await saveState(stateDir, { ...sample, t3AccessToken: undefined }, { credentialStore: store });
  const output = capture();
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const fetchImpl = async (url) => String(url).endsWith("/.well-known/t3/environment")
    ? new Response(JSON.stringify({ version: "test" }))
    : new Response(JSON.stringify({ ok: true }));
  const missingTailscale = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  assert.equal(await main(["status", "--json", "--state-dir", stateDir], {
    stdout: output, stderr: output, credentialStore: store, platform: "linux", home: scratch, env, fetchImpl, exec: missingTailscale,
  }), 1);
  const status = JSON.parse(output.value());
  assert.deepEqual(status.credentialStorage, { backend: "macos-keychain", native: true, fallbackReason: null });
  assert.equal(output.value().includes(sample.secret), false);
  output.clear();
  assert.equal(await main(["disconnect", "--force-local", "--yes", "--state-dir", stateDir], {
    stdout: output, stderr: output, credentialStore: store, platform: "linux", home: scratch, env,
  }), 0);
  assert.equal(store.values.size, 0);
});

test("cloud revocation completes before native and file credentials are removed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-native-cloud-revoke-"));
  const store = memoryStore();
  await saveState(stateDir, sample, { credentialStore: store });
  let attempts = 0;
  const dependencies = {
    stdout: capture(), stderr: capture(), credentialStore: store, platform: "linux",
    env: { XDG_CONFIG_HOME: join(stateDir, "config") },
    revokeCloudConnector: async (state) => {
      attempts += 1;
      assert.equal(state.secret, sample.secret);
      assert.ok(store.values.size > 0, "native credential must still exist during cloud revocation");
      if (attempts === 1) throw new Error("transient edge failure");
    },
  };
  assert.equal(await main(["disconnect", "--revoke-cloud", "--yes", "--state-dir", stateDir], dependencies), 1);
  assert.equal((await loadState(stateDir, { credentialStore: store })).connectorId, sample.connectorId);
  assert.ok(store.values.size > 0);
  assert.equal(await main(["disconnect", "--revoke-cloud", "--yes", "--state-dir", stateDir], dependencies), 0);
  assert.equal(store.values.size, 0);
  assert.equal(await loadState(stateDir, { credentialStore: store }), null);
  assert.equal(dependencies.stderr.value().includes(sample.secret), false);
});

function memoryStore({ failWrite = false } = {}) {
  const values = new Map();
  return {
    backend: "macos-keychain", native: true, fallbackReason: null, values,
    async write(account, secret) { if (failWrite) throw Object.assign(new Error("safe failure"), { code: "CREDENTIAL_STORE_OPERATION" }); values.set(account, secret); },
    async read(account) { return values.get(account) ?? null; },
    failDelete: false,
    async delete(account) { if (this.failDelete) throw Object.assign(new Error("safe delete failure"), { code: "CREDENTIAL_STORE_OPERATION" }); values.delete(account); },
  };
}

function ok(stdout = "") { return { code: 0, stdout, stderr: "" }; }
function capture() { let value = ""; return { write(chunk) { value += chunk; }, value() { return value; }, clear() { value = ""; } }; }

function main(args, dependencies = {}) { return realMain(args, { inspectVoiceRuntime: async () => ({ ready: true }), prepareVoiceRuntime: async () => ({ url: "http://127.0.0.1:8977/v1/transcribe", close: async () => {}, ensureReady: async () => {} }), ...dependencies }); }
