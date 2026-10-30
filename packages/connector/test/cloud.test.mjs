import assert from "node:assert/strict";
import test from "node:test";
import { defaultConnectorLabel, describeHostPlatform, enrollConnector, requestSocketTicket, revokeCloudConnector } from "../src/cloud.mjs";

test("enrollment never sends local T3 authority to cloud", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ connector: { id: "con_1" }, environment: { id: "env_1" }, secret: "secret" }), { status: 201 });
  };
  const result = await enrollConnector({ server: "https://cloud.example", code: "short-code", label: "Laptop", capabilities: ["snapshot"], platform: "darwin", fetchImpl });
  assert.equal(result.connectorId, "con_1");
  assert.deepEqual(Object.keys(request.body).sort(), ["capabilities", "code", "connectorVersion", "label", "platform", "protocolVersion"]);
  assert.equal(JSON.stringify(request.body).includes("3773"), false);
});

test("ticket uses connector realm authorization", async () => {
  let authorization;
  const fetchImpl = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({ ticket: "short-lived" }), { status: 201 });
  };
  const ticket = await requestSocketTicket({ server: "https://cloud.example", connectorId: "con_1", secret: "standing" }, { fetchImpl });
  assert.equal(ticket.ticket, "short-lived");
  assert.equal(authorization, "Connector con_1.standing");
});

test("self-revocation uses only the connector realm and validates response identity", async () => {
  let request;
  const state = { server: "https://cloud.example", connectorId: "con_1", environmentId: "env_1", secret: "standing" };
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ connector: { id: "con_1", environmentId: "env_1", status: "revoked" } }));
  };
  await revokeCloudConnector(state, { fetchImpl });
  assert.equal(request.url, "https://cloud.example/v1/connectors/self/revoke");
  assert.equal(request.options.headers.authorization, "Connector con_1.standing");
  assert.equal(JSON.stringify(request).includes("Bearer"), false);
  await assert.rejects(revokeCloudConnector(state, {
    fetchImpl: async () => new Response(JSON.stringify({ connector: { id: "other", environmentId: "env_1", status: "revoked" } })),
  }), { code: "REVOCATION_INVALID" });
});

test("a computer names itself after its host, never after a platform guess", () => {
  // The console used to prefill the literal "Mac T3 Code" for every new environment, so a Windows
  // host enrolled as a Mac and a second workspace was indistinguishable from the first.
  assert.equal(defaultConnectorLabel({ platform: "win32", hostname: "SERGE-PC" }), "SERGE-PC (Windows)");
  assert.equal(defaultConnectorLabel({ platform: "linux", hostname: "build-01" }), "build-01 (Linux)");
  // A trailing .local is mDNS noise, not part of the computer's name.
  assert.equal(defaultConnectorLabel({ platform: "darwin", hostname: "Serges-MacBook-Pro.local" }), "Serges-MacBook-Pro");
  // No "mac-mini (macOS)": the name already says it.
  assert.equal(defaultConnectorLabel({ platform: "darwin", hostname: "mac-mini" }), "mac-mini");
  assert.equal(defaultConnectorLabel({ platform: "linux", hostname: "ubuntu-box" }), "ubuntu-box");
});

test("an unusable hostname still produces a label that distinguishes the platform", () => {
  // An explicit null means "this host has no usable name"; omitting the argument entirely still
  // reads the real os.hostname(), which is why undefined is not in this list.
  for (const hostname of ["", "   ", "localhost", "LOCALHOST", null]) {
    assert.equal(defaultConnectorLabel({ platform: "win32", hostname }), "Windows computer");
  }
  assert.equal(defaultConnectorLabel({ platform: "win32" }).length > 0, true);
  // An unknown platform must not invent a name for itself.
  assert.equal(defaultConnectorLabel({ platform: "haiku", hostname: "" }), "T3 Code");
  assert.equal(describeHostPlatform("haiku"), null);
  assert.equal(describeHostPlatform("win32"), "Windows");
});

test("a host-derived label is sent when the owner passed none, and never overrides one they did", async () => {
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ connector: { id: "con_1" }, environment: { id: "env_1" }, secret: "s" }), { status: 201 });
  };
  await enrollConnector({ server: "https://cloud.example", code: "c", platform: "win32", fetchImpl });
  assert.equal(typeof sent[0].label, "string");
  assert.equal(sent[0].label.length > 0, true, "an unnamed host must still send a name");
  assert.equal(sent[0].label.includes("Mac"), false);

  await enrollConnector({ server: "https://cloud.example", code: "c", label: "  Studio desk  ", platform: "win32", fetchImpl });
  assert.equal(sent[1].label, "Studio desk", "an explicit label wins and is trimmed");
});

test("a blank explicit label falls back to the host name rather than enrolling unnamed", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ connector: { id: "con_1" }, environment: { id: "env_1" }, secret: "s" }), { status: 201 });
  };
  await enrollConnector({ server: "https://cloud.example", code: "c", label: "   ", platform: "linux", fetchImpl });
  assert.equal(body.label.trim().length > 0, true);
});
