import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  normalizeConfiguration,
  parseArguments,
  runConnectorRevocationDrill,
} from "../scripts/drill-connector-revocation.mjs";

const TOKEN = "drill-platform-token-never-emit";
const SECRET_PREFIX = "drill-connector-secret-never-emit";

test("the revocation drill refuses an unsafe or credential-free target before any fetch", async () => {
  let calls = 0;
  const missing = await runConnectorRevocationDrill({}, { fetchImpl: async () => { calls += 1; } });
  assert.equal(missing.result, "failed");
  assert.equal(missing.checks[0].code, "base_url_required");
  assert.equal(missing.drill, "connector-revocation");
  assert.equal(calls, 0);

  const noToken = await runConnectorRevocationDrill(
    { baseUrl: "https://staging.example.test" },
    { fetchImpl: async () => { calls += 1; } },
  );
  assert.equal(noToken.checks[0].code, "access_token_required");
  assert.equal(calls, 0);

  assert.throws(
    () => normalizeConfiguration({ baseUrl: "http://staging.example.test", accessToken: TOKEN }),
    (error) => error.code === "https_required",
  );
  assert.throws(
    () => normalizeConfiguration({ baseUrl: "https://staging.example.test/path", accessToken: TOKEN }),
    (error) => error.code === "base_url_must_be_origin",
  );
});

test("a preflight run mutates nothing and reports every revocation check as skipped", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runConnectorRevocationDrill({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
  });

  assert.equal(evidence.mode, "preflight");
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.summary.failed, 0);
  assert.equal(evidence.summary.skipped, 9);
  for (const check of evidence.checks.filter((entry) => entry.status === "skipped")) {
    assert.equal(check.code, "exercise_flag_required");
  }
  assert.equal(gateway.calls.some((call) => call.path === "/v1/connectors/enroll"), false);
  assert.equal(gateway.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(gateway.environments.size, 0);
});

test("the full drill enrolls, mints a ticket, revokes, re-enrolls, and archives its own environment", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runConnectorRevocationDrill({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
    exerciseRevocation: true,
  });

  assert.equal(evidence.mode, "exercise");
  assert.equal(evidence.result, "passed");
  assert.equal(evidence.summary.skipped, 0);
  assert.equal(evidence.summary.failed, 0);
  assert.deepEqual(evidence.checks.map((check) => check.name), [
    "configuration",
    "deployment_mode",
    "owner_realm_authenticated",
    "drill_environment_created",
    "connector_enrolled",
    "socket_ticket_minted",
    "connector_revoked",
    "revoked_credential_refused",
    "revocation_visible_to_owner",
    "replacement_enrollment_succeeded",
    "superseded_connector_stays_revoked",
    "drill_environment_archived",
  ]);

  // Exactly one environment was created, and it belongs to the drill, not to the operator.
  assert.equal(gateway.environments.size, 1);
  const [environment] = [...gateway.environments.values()];
  assert.ok(environment.archivedAt);
  const connectors = [...gateway.connectors.values()];
  assert.equal(connectors.length, 2);
  assert.equal(connectors.filter((connector) => connector.revokedAt).length, 2);
  assertRedacted(evidence, gateway);
});

test("a gateway that keeps honouring a revoked credential fails the drill and still cleans up", async (t) => {
  const gateway = createGateway({ honourRevokedCredential: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runConnectorRevocationDrill({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
    exerciseRevocation: true,
  });

  assert.equal(evidence.result, "failed");
  const refused = evidence.checks.find((check) => check.name === "revoked_credential_refused");
  assert.equal(refused.status, "failed");
  assert.equal(refused.code, "revoked_credential_still_accepted");
  assert.equal(refused.httpStatus, 201);
  const archived = evidence.checks.find((check) => check.name === "drill_environment_archived");
  assert.equal(archived.status, "passed");
  assert.equal([...gateway.environments.values()][0].archivedAt !== null, true);
  assertRedacted(evidence, gateway);
});

test("a drill environment that cannot be created skips every later check instead of guessing", async (t) => {
  const gateway = createGateway({ failEnrollment: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runConnectorRevocationDrill({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
    exerciseRevocation: true,
  });

  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "drill_environment_created")?.code, "connector_enrollment_failed");
  const skipped = evidence.checks.filter((check) => check.status === "skipped");
  assert.equal(skipped.length, 8);
  assert.equal(skipped.at(-1).name, "drill_environment_archived");
  assert.equal(skipped.at(-1).code, "drill_environment_not_created");
});

test("drill arguments never accept a token as a command-line value", () => {
  const parsed = parseArguments(["--base-url", "https://staging.example.test", "--exercise-revocation"], {
    NEXT_CODER_DRILL_ACCESS_TOKEN: TOKEN,
  });
  assert.equal(parsed.accessToken, TOKEN);
  assert.equal(parsed.exerciseRevocation, true);
  assert.equal(parsed.baseUrl, "https://staging.example.test");

  assert.throws(() => parseArguments(["--access-token", TOKEN], {}), (error) => error.code === "unknown_option");
  assert.throws(
    () => parseArguments(["--access-token-file", "/tmp/token"], { NEXT_CODER_DRILL_ACCESS_TOKEN: TOKEN }),
    (error) => error.code === "one_access_token_source_required",
  );
  assert.throws(() => parseArguments(["--base-url"], {}), (error) => error.code === "option_value_required");
  assert.equal(parseArguments(["--help"], {}).help, true);

  // The mutation flag is off unless it is typed.
  assert.equal(parseArguments(["--base-url", "https://staging.example.test"], {}).exerciseRevocation, false);
});

function createGateway({ honourRevokedCredential = false, failEnrollment = false } = {}) {
  const environments = new Map();
  const connectors = new Map();
  const sessions = new Map();
  const calls = [];
  let counter = 0;

  const nextId = (prefix) => {
    counter += 1;
    return `${prefix}_private_${counter}`;
  };

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    const path = url.pathname;
    calls.push({ method: request.method, path });

    if (path === "/v1/auth/config") {
      return sendJson(response, 200, { authProvider: "clerk", deploymentMode: "cloud", developmentTokens: { enabled: false } });
    }

    if (path === "/v1/connectors/enroll" && request.method === "POST") {
      if (failEnrollment) return sendJson(response, 500, { error: { message: "private enrollment failure detail" } });
      const body = await readJson(request);
      const session = sessions.get(body.code);
      if (!session) return sendJson(response, 410, { error: { message: "code_unusable" } });
      sessions.delete(body.code);
      const environmentId = session.environmentId ?? nextId("env");
      const environment = environments.get(environmentId) ?? {
        id: environmentId,
        label: body.label ?? "T3 Code",
        transportMode: "connector",
        archivedAt: null,
      };
      environments.set(environmentId, environment);
      for (const connector of connectors.values()) {
        if (connector.environmentId === environmentId && !connector.revokedAt) {
          connector.revokedAt = new Date().toISOString();
          connector.status = "revoked";
        }
      }
      const connector = {
        id: nextId("ctr"),
        environmentId,
        status: "enrolled",
        protocolVersion: 1,
        revokedAt: null,
        secret: `${SECRET_PREFIX}-${counter}`,
      };
      connectors.set(connector.id, connector);
      return sendJson(response, 201, {
        session: { id: session.id, status: "completed" },
        environment,
        connector: publicConnector(connector),
        secret: connector.secret,
      });
    }

    if (path === "/v1/connectors/ticket" && request.method === "POST") {
      const match = String(request.headers.authorization ?? "").match(/^Connector ([^.\s]+)\.([^\s]+)$/u);
      const connector = match ? connectors.get(match[1]) : null;
      if (!connector || connector.secret !== match[2]) {
        return sendJson(response, 401, { error: { message: "invalid connector credential" } });
      }
      if (connector.revokedAt && !honourRevokedCredential) {
        return sendJson(response, 401, { error: { message: "connector revoked" } });
      }
      return sendJson(response, 201, {
        ticket: `drill-socket-ticket-never-emit-${counter}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(response, 401, { error: { message: "private token detail must not enter evidence" } });
    }

    if (path === "/v1/connectors" && request.method === "GET") {
      return sendJson(response, 200, { connectors: [...connectors.values()].map(publicConnector) });
    }

    if (path === "/v1/t3/connect-sessions" && request.method === "POST") {
      const body = await readJson(request);
      const session = { id: nextId("cs"), environmentId: body.environmentId ?? null };
      const code = `drill-code-never-emit-${counter}`;
      sessions.set(code, session);
      return sendJson(response, 201, { session, code, gatewayUrl: "https://staging.example.test" });
    }

    const revokeMatch = path.match(/^\/v1\/connectors\/([^/]+)$/u);
    if (revokeMatch && request.method === "DELETE") {
      const connector = connectors.get(revokeMatch[1]);
      if (!connector) return sendJson(response, 404, { error: { message: "not found" } });
      connector.revokedAt = connector.revokedAt ?? new Date().toISOString();
      connector.status = "revoked";
      return sendJson(response, 200, { connector: publicConnector(connector) });
    }

    const archiveMatch = path.match(/^\/v1\/t3\/environments\/([^/]+)\/archive$/u);
    if (archiveMatch && request.method === "POST") {
      const environment = environments.get(archiveMatch[1]);
      if (!environment) return sendJson(response, 404, { error: { message: "not found" } });
      environment.archivedAt = new Date().toISOString();
      for (const connector of connectors.values()) {
        if (connector.environmentId === environment.id && !connector.revokedAt) {
          connector.revokedAt = environment.archivedAt;
          connector.status = "revoked";
        }
      }
      return sendJson(response, 200, { environment });
    }

    return sendJson(response, 404, { error: { message: "private missing route detail" } });
  };

  return { handler, calls, environments, connectors, sessions };
}

function publicConnector(connector) {
  const { secret, ...rest } = connector;
  return rest;
}

async function startFixture(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_failed" });
      else response.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function assertRedacted(evidence, gateway) {
  const serialized = JSON.stringify(evidence);
  const secrets = [TOKEN, SECRET_PREFIX, "drill-socket-ticket", "drill-code-never-emit", "private enrollment failure detail"];
  for (const connector of gateway.connectors.values()) secrets.push(connector.id, connector.secret);
  for (const environment of gateway.environments.keys()) secrets.push(environment);
  for (const value of secrets) {
    assert.equal(serialized.includes(value), false, `drill evidence leaked ${value}`);
  }
}
