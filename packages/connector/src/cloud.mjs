import { hostname as osHostname } from "node:os";
import { connectorAuthorization, requestJson } from "./http.mjs";

export const PROTOCOL_VERSION = 1;
export const CONNECTOR_VERSION = "0.1.0";

/**
 * How a computer names itself when the owner did not pass `--label`.
 *
 * The console used to prefill the literal string "Mac T3 Code" for every new environment, so a
 * Windows machine offered to enrol itself as a Mac and the owner could not tell a new workspace
 * from the one already in the list. The host is the only party that knows its own name, so it
 * says so at enrollment and the gateway keeps that name unless the owner typed one.
 *
 * `os.hostname()` is used rather than a platform word because two Macs are two different
 * computers and "Mac" distinguishes neither. The platform is appended only when the bare hostname
 * would not already imply it, so a machine called `serge-windows-pc` is not labelled
 * "serge-windows-pc (Windows)".
 */
export const PLATFORM_LABELS = Object.freeze({
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  sunos: "illumos",
  aix: "AIX",
});

export function describeHostPlatform(platform) {
  return PLATFORM_LABELS[platform] ?? null;
}

export function defaultConnectorLabel({ platform, hostname = osHostname() } = {}) {
  // macOS hands back "Serges-MacBook-Pro.local"; the suffix is noise on a label.
  const bare = String(hostname ?? "").trim().replace(/\.local$/iu, "").replace(/\.lan$/iu, "");
  const host = bare.length > 0 && bare.toLowerCase() !== "localhost" ? bare.slice(0, 60) : null;
  const platformName = describeHostPlatform(platform);
  if (!host) return platformName ? `${platformName} computer` : "T3 Code";
  if (!platformName) return host;
  // Avoid "mac-mini (macOS)" and "win-box (Windows)" by not repeating what the name already says.
  const collapsed = host.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const implied = platform === "darwin" ? ["mac", "imac", "macbook"] : platform === "win32" ? ["windows", "win"] : ["linux", "ubuntu", "debian", "fedora"];
  if (implied.some((token) => collapsed.includes(token))) return host;
  return `${host} (${platformName})`;
}

export async function enrollConnector({ server, code, label, capabilities = [], fetchImpl, platform }) {
  const payload = await requestJson(new URL("/v1/connectors/enroll", server), {
    fetchImpl,
    method: "POST",
    body: {
      code,
      // Always send a label: an unnamed machine is what produced the "is this the Mac I already
      // set up?" confusion. An owner-supplied --label still wins over the derived name.
      label: String(label ?? "").trim() || defaultConnectorLabel({ platform }),
      protocolVersion: PROTOCOL_VERSION,
      connectorVersion: CONNECTOR_VERSION,
      platform,
      capabilities,
    },
    expected: [200, 201],
  });
  const connectorId = payload?.connector?.id;
  const environmentId = payload?.environment?.id ?? payload?.connector?.environmentId;
  if (!connectorId || !environmentId || !payload?.secret) {
    throw Object.assign(new Error("Enrollment response is missing connector, environment, or secret."), { code: "ENROLLMENT_INVALID" });
  }
  return { connectorId, environmentId, secret: payload.secret, connector: payload.connector, environment: payload.environment };
}

export async function requestSocketTicket(state, { fetchImpl } = {}) {
  const payload = await requestJson(new URL("/v1/connectors/ticket", state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: {},
    expected: [200, 201],
  });
  if (!payload?.ticket) throw Object.assign(new Error("Ticket response did not include a ticket."), { code: "TICKET_INVALID" });
  return payload;
}

export async function revokeCloudConnector(state, { fetchImpl } = {}) {
  const payload = await requestJson(new URL("/v1/connectors/self/revoke", state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: {},
    expected: [200],
  });
  if (payload?.connector?.id !== state.connectorId
    || payload.connector.environmentId !== state.environmentId
    || payload.connector.status !== "revoked") {
    throw Object.assign(new Error("Cloud revocation response does not match this connector."), { code: "REVOCATION_INVALID" });
  }
  return payload.connector;
}

export async function beginCredentialRotation(state, { code, fetchImpl } = {}) {
  const payload = await requestJson(new URL(`/v1/connectors/${encodeURIComponent(state.connectorId)}/rotate`, state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: { code },
    expected: [201],
  });
  if (payload?.connector?.id !== state.connectorId
    || payload.connector.environmentId !== state.environmentId
    || !payload?.rotation?.id
    || !payload?.rotation?.expiresAt
    || !payload?.secret) {
    throw Object.assign(new Error("Rotation response is missing the connector, rotation, or staged credential."), { code: "ROTATION_INVALID" });
  }
  return {
    connectorId: payload.connector.id,
    environmentId: payload.connector.environmentId,
    rotationId: payload.rotation.id,
    expiresAt: payload.rotation.expiresAt,
    secret: payload.secret,
  };
}

export function cloudSocketUrl(server, ticket) {
  const url = new URL("/v1/connectors/socket", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
