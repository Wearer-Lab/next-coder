#!/usr/bin/env node

// Phase 4.2 — online connector revocation drill (credential half).
//
// WHAT THIS EXERCISES
// A connector credential is enrolled against a throwaway drill environment that this script
// creates and archives itself, a socket ticket is minted with it, the owner revokes the connector,
// and the drill then proves that the same credential can no longer mint a ticket, that the
// revocation is visible on the owner's connector list, and that a replacement enrollment produces
// a distinct live credential while the revoked one stays revoked.
//
// WHAT THIS DOES NOT EXERCISE — see docs/staging-drills.md
// No WebSocket is ever opened, so this proves nothing about an established socket closing, about a
// heartbeat ceasing, about in-flight T3 work terminalising, or about the edge Durable Object
// refusing an already-minted ticket: that ticket-consume route is private and answers 404 from the
// public origin by design. Those observations require a live connector process and the deployed
// edge, and remain a hosted operator step.
//
// SAFETY
// The drill never enrolls into an environment it did not create. Enrollment supersedes and revokes
// whatever connector currently serves an environment (src/store.mjs createConnector), so pointing
// this at a working environment would disconnect the operator's real connector. There is no option
// to do that.

import { pathToFileURL } from "node:url";

import {
  ACCESS_TOKEN_FILE_OPTION,
  DrillError,
  boundedInteger,
  configurationFailureEvidence,
  createRequester,
  emitEvidence,
  finishEvidence,
  loadAccessTokenFile,
  nonEmpty,
  oneOf,
  opaqueRef,
  parseDrillArguments,
  requireArray,
  requireCondition,
  requireIdentifier,
  requireRecord,
  requireSecret,
  requireStatus,
  runCheck,
  normalizeBaseUrl,
  skipped,
} from "./drill-common.mjs";

const DRILL = "connector-revocation";
const DEFAULT_LABEL = "Revocation drill environment (safe to archive)";

const MUTATING_CHECKS = [
  "drill_environment_created",
  "connector_enrolled",
  "socket_ticket_minted",
  "connector_revoked",
  "revoked_credential_refused",
  "revocation_visible_to_owner",
  "replacement_enrollment_succeeded",
  "superseded_connector_stays_revoked",
  "drill_environment_archived",
];

export async function runConnectorRevocationDrill(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const startedAtMs = now();
  const checks = [];
  let configuration;

  try {
    configuration = normalizeConfiguration(input);
    checks.push({
      name: "configuration",
      status: "passed",
      durationMs: 0,
      mode: configuration.exercise ? "exercise" : "preflight",
      expectedDeploymentMode: configuration.expectedDeploymentMode,
    });
  } catch (error) {
    return finishEvidence({
      drill: DRILL,
      mode: "preflight",
      checks: [{ name: "configuration", status: "failed", durationMs: 0, code: error instanceof DrillError ? error.code : "invalid_configuration" }],
      startedAtMs,
      now,
      target: null,
    });
  }

  const mode = configuration.exercise ? "exercise" : "preflight";
  const { request } = createRequester({
    baseUrl: configuration.baseUrl,
    fetchImpl,
    requestTimeoutMs: configuration.requestTimeoutMs,
  });
  const owner = { authorization: `Bearer ${configuration.accessToken}` };
  const finish = () => finishEvidence({ drill: DRILL, mode, checks, startedAtMs, now, target: configuration.baseUrl.origin });

  const deploymentReady = await runCheck(checks, "deployment_mode", now, async () => {
    const response = await request("/v1/auth/config");
    requireStatus(response, 200, "auth_config_unavailable");
    const body = requireRecord(response.body, "invalid_auth_config_contract");
    requireCondition(body.deploymentMode === configuration.expectedDeploymentMode, "unexpected_deployment_mode");
    return { httpStatus: response.status, deploymentMode: configuration.expectedDeploymentMode };
  });

  const ownerReady = await runCheck(checks, "owner_realm_authenticated", now, async () => {
    const response = await request("/v1/connectors", { headers: owner });
    requireStatus(response, 200, "connector_list_failed");
    const connectors = requireArray(response.body?.connectors, "invalid_connector_list_contract");
    return { httpStatus: response.status, connectorCount: connectors.length };
  });

  if (!configuration.exercise) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "exercise_flag_required"));
    return finish();
  }
  if (!deploymentReady || !ownerReady) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "preflight_check_failed"));
    return finish();
  }

  // Everything below mutates. `state` carries the one live secret this process holds; it is never
  // written to evidence, only used to build an Authorization header.
  const state = { environmentId: null, connectorId: null, secret: null, replacementId: null, replacementSecret: null };

  const enroll = async ({ environmentId }) => {
    const session = await request("/v1/t3/connect-sessions", {
      method: "POST",
      headers: owner,
      body: {
        label: configuration.label,
        accessMode: "local",
        ...(environmentId ? { environmentId } : {}),
      },
    });
    requireStatus(session, 201, "connect_session_failed");
    const code = requireIdentifier(session.body?.code, "invalid_connect_session_contract");
    const enrolled = await request("/v1/connectors/enroll", {
      method: "POST",
      body: { code, protocolVersion: 1, label: configuration.label },
    });
    requireStatus(enrolled, 201, "connector_enrollment_failed");
    const connector = requireRecord(enrolled.body?.connector, "invalid_enrollment_contract");
    const environment = requireRecord(enrolled.body?.environment, "invalid_enrollment_contract");
    return {
      connectorId: requireIdentifier(connector.id, "invalid_enrollment_contract"),
      environmentId: requireIdentifier(environment.id, "invalid_enrollment_contract"),
      transportMode: environment.transportMode,
      status: connector.status,
      revokedAt: connector.revokedAt ?? null,
      secret: requireSecret(enrolled.body?.secret, "enrollment_secret_missing"),
    };
  };

  const mintTicket = async (connectorId, secret) => await request("/v1/connectors/ticket", {
    method: "POST",
    headers: { authorization: `Connector ${connectorId}.${secret}` },
  });

  try {
    const created = await runCheck(checks, "drill_environment_created", now, async () => {
      const enrolled = await enroll({});
      state.environmentId = enrolled.environmentId;
      state.connectorId = enrolled.connectorId;
      state.secret = enrolled.secret;
      requireCondition(enrolled.transportMode === "connector", "drill_environment_not_connector_backed");
      return { environmentRef: opaqueRef(enrolled.environmentId), transportMode: "connector" };
    });

    if (created) {
      await runCheck(checks, "connector_enrolled", now, async () => {
        const response = await request("/v1/connectors", { headers: owner });
        requireStatus(response, 200, "connector_list_failed");
        const connectors = requireArray(response.body?.connectors, "invalid_connector_list_contract");
        const connector = connectors.find((candidate) => candidate?.id === state.connectorId);
        requireCondition(Boolean(connector), "enrolled_connector_not_listed");
        requireCondition(!connector.revokedAt && connector.status !== "revoked", "enrolled_connector_already_revoked");
        requireCondition(connector.environmentId === state.environmentId, "enrolled_connector_environment_mismatch");
        requireCondition(connector.protocolVersion === 1, "connector_protocol_incompatible");
        return { connectorRef: opaqueRef(state.connectorId), connectorStatus: "live", protocolVersion: 1 };
      });

      await runCheck(checks, "socket_ticket_minted", now, async () => {
        const response = await mintTicket(state.connectorId, state.secret);
        requireStatus(response, 201, "ticket_mint_failed");
        const body = requireRecord(response.body, "invalid_ticket_contract");
        requireSecret(body.ticket, "invalid_ticket_contract");
        requireCondition(typeof body.expiresAt === "string" && Number.isFinite(Date.parse(body.expiresAt)), "invalid_ticket_contract");
        // The ticket itself is a bearer credential for the edge socket and never enters evidence.
        return { httpStatus: response.status, ticketIssued: true };
      });

      await runCheck(checks, "connector_revoked", now, async () => {
        const response = await request(`/v1/connectors/${encodeURIComponent(state.connectorId)}`, {
          method: "DELETE",
          headers: owner,
        });
        requireStatus(response, 200, "connector_revocation_failed");
        const connector = requireRecord(response.body?.connector, "invalid_revocation_contract");
        requireCondition(connector.status === "revoked", "connector_not_marked_revoked");
        requireCondition(typeof connector.revokedAt === "string" && Number.isFinite(Date.parse(connector.revokedAt)), "revocation_timestamp_missing");
        return { httpStatus: response.status, connectorStatus: "revoked" };
      });

      await runCheck(checks, "revoked_credential_refused", now, async () => {
        const response = await mintTicket(state.connectorId, state.secret);
        requireStatus(response, 401, "revoked_credential_still_accepted");
        return { httpStatus: response.status, ticketIssued: false };
      });

      await runCheck(checks, "revocation_visible_to_owner", now, async () => {
        const response = await request("/v1/connectors", { headers: owner });
        requireStatus(response, 200, "connector_list_failed");
        const connectors = requireArray(response.body?.connectors, "invalid_connector_list_contract");
        const connector = connectors.find((candidate) => candidate?.id === state.connectorId);
        requireCondition(Boolean(connector), "revoked_connector_not_listed");
        requireCondition(Boolean(connector.revokedAt) || connector.status === "revoked", "revoked_connector_still_live");
        const live = connectors.filter((candidate) => candidate?.environmentId === state.environmentId
          && !candidate?.revokedAt && candidate?.status !== "revoked");
        requireCondition(live.length === 0, "environment_still_has_live_connector");
        return { liveConnectors: 0, connectorStatus: "revoked" };
      });

      await runCheck(checks, "replacement_enrollment_succeeded", now, async () => {
        const enrolled = await enroll({ environmentId: state.environmentId });
        state.replacementId = enrolled.connectorId;
        state.replacementSecret = enrolled.secret;
        requireCondition(enrolled.connectorId !== state.connectorId, "replacement_reused_revoked_connector");
        requireCondition(enrolled.environmentId === state.environmentId, "replacement_environment_mismatch");
        const ticket = await mintTicket(enrolled.connectorId, enrolled.secret);
        requireStatus(ticket, 201, "replacement_ticket_mint_failed");
        return { connectorRef: opaqueRef(enrolled.connectorId), connectorStatus: "live", ticketIssued: true };
      });

      await runCheck(checks, "superseded_connector_stays_revoked", now, async () => {
        requireCondition(Boolean(state.replacementId), "replacement_connector_missing");
        const response = await request("/v1/connectors", { headers: owner });
        requireStatus(response, 200, "connector_list_failed");
        const connectors = requireArray(response.body?.connectors, "invalid_connector_list_contract");
        const original = connectors.find((candidate) => candidate?.id === state.connectorId);
        requireCondition(Boolean(original?.revokedAt) || original?.status === "revoked", "revoked_connector_resurrected");
        const live = connectors.filter((candidate) => candidate?.environmentId === state.environmentId
          && !candidate?.revokedAt && candidate?.status !== "revoked");
        requireCondition(live.length === 1, "environment_live_connector_count_unexpected");
        requireCondition(live[0]?.id === state.replacementId, "unexpected_live_connector");
        const stale = await mintTicket(state.connectorId, state.secret);
        requireStatus(stale, 401, "revoked_credential_still_accepted");
        return { liveConnectors: 1, revokedCredentialAccepted: false };
      });
    } else {
      // Everything downstream needs the drill environment. Nothing is guessed at, and no check
      // that did not run is reported as anything but skipped.
      for (const name of MUTATING_CHECKS.slice(1, -1)) checks.push(skipped(name, "drill_environment_unavailable"));
    }
  } finally {
    // Cleanup is itself a recorded check: an operator has to know when a drill environment was
    // left behind, and archiving also closes the replacement connector's edge session. It runs
    // before the evidence is sealed, so the summary counts it.
    if (state.environmentId) {
      await runCheck(checks, "drill_environment_archived", now, async () => {
        const response = await request(`/v1/t3/environments/${encodeURIComponent(state.environmentId)}/archive`, {
          method: "POST",
          headers: owner,
        });
        requireStatus(response, 200, "drill_environment_archive_failed");
        return { httpStatus: response.status, environmentRef: opaqueRef(state.environmentId), archived: true };
      });
    } else {
      checks.push(skipped("drill_environment_archived", "drill_environment_not_created"));
    }
  }

  return finish();
}

export function normalizeConfiguration(input = {}) {
  const baseUrl = normalizeBaseUrl(input);
  const accessToken = nonEmpty(input.accessToken);
  if (!accessToken) throw new DrillError("access_token_required");
  const label = nonEmpty(input.label) ?? DEFAULT_LABEL;
  if (label.length > 120) throw new DrillError("label_too_long");
  return {
    baseUrl,
    accessToken,
    label,
    exercise: input.exerciseRevocation === true,
    expectedDeploymentMode: oneOf(nonEmpty(input.expectedDeploymentMode) ?? "cloud", ["cloud", "self-hosted"], "expected_deployment_mode_invalid"),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 15_000, 1_000, 60_000, "request_timeout_invalid"),
  };
}

export function parseArguments(argv, environment = process.env) {
  return parseDrillArguments(argv, {
    environment,
    envDefaults: {
      baseUrl: "NEXT_CODER_DRILL_URL",
      accessToken: "NEXT_CODER_DRILL_ACCESS_TOKEN",
      expectedDeploymentMode: "NEXT_CODER_DRILL_DEPLOYMENT_MODE",
      requestTimeoutMs: "NEXT_CODER_DRILL_REQUEST_TIMEOUT_MS",
    },
    valueOptions: {
      "--base-url": "baseUrl",
      "--label": "label",
      "--expected-deployment-mode": "expectedDeploymentMode",
      "--request-timeout-ms": "requestTimeoutMs",
    },
    flagOptions: {
      "--exercise-revocation": "exerciseRevocation",
      "--allow-http-loopback": "allowHttpLoopback",
    },
    fileOptions: ACCESS_TOKEN_FILE_OPTION,
  });
}

export function helpText() {
  return `Next Coder staging drill: connector revocation (completion plan 4.2)

Preflight (no mutation; every revocation check is reported as skipped, so the record cannot be
filed as proof):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:connector-revocation -- \\
    --base-url https://staging.example.com

Full drill (creates its own throwaway environment, enrolls, revokes, re-enrolls, archives):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:connector-revocation -- \\
    --base-url https://staging.example.com --exercise-revocation

The platform token comes from NEXT_CODER_DRILL_ACCESS_TOKEN or a mode-0600 file passed with
--access-token-file PATH. There is no option that takes a token as a command-line value.

This drill never touches an environment it did not create, because enrollment supersedes an
environment's existing connector. It proves credential death and replacement enrollment; it does
not prove socket closure, heartbeat cessation, in-flight terminalisation, or edge ticket rejection.
See docs/staging-drills.md.`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    if (parsed.accessTokenFile) parsed.accessToken = await loadAccessTokenFile(parsed.accessTokenFile);
  } catch (error) {
    await emitEvidence(configurationFailureEvidence({
      drill: DRILL,
      code: error instanceof DrillError ? error.code : "invalid_configuration",
    }));
    process.exitCode = 2;
    return;
  }
  const evidence = await emitEvidence(await runConnectorRevocationDrill(parsed));
  if (evidence.result !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
