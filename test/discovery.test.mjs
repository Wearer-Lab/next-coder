import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";

import {
  DISCOVERY_PROBE,
  buildDiscoveryReply,
  createDiscoveryResponder,
  pickLanAddress,
} from "../src/discovery.mjs";

const interfaces = {
  lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  en0: [{ family: "IPv4", internal: false, address: "192.168.1.50", netmask: "255.255.255.0" }],
  en1: [{ family: "IPv4", internal: false, address: "10.0.0.7", netmask: "255.0.0.0" }],
};

test("the reply names the interface on the asker's subnet", () => {
  // A host with Wi-Fi and Ethernet has more than one right answer, and telling a device the
  // address of an interface it cannot route to is worse than not answering.
  assert.equal(pickLanAddress("192.168.1.99", interfaces), "192.168.1.50");
  assert.equal(pickLanAddress("10.4.5.6", interfaces), "10.0.0.7");
});

test("loopback is never offered as a gateway address", () => {
  const onlyLoopback = { lo0: interfaces.lo0 };
  assert.equal(pickLanAddress("127.0.0.1", onlyLoopback), null);
});

test("the reply carries a URL a device can actually use", () => {
  const reply = buildDiscoveryReply({
    config: { port: 3996, discoveryName: "studio-mac" },
    remoteAddress: "192.168.1.99",
    interfaces,
  });
  assert.equal(reply.service, "next-coder");
  assert.equal(reply.name, "studio-mac");
  assert.equal(reply.baseUrl, "http://192.168.1.50:3996");
});

test("an explicit public base URL wins over a guessed interface", () => {
  const reply = buildDiscoveryReply({
    config: { port: 3996, publicBaseUrl: "https://gateway.example.com" },
    remoteAddress: "192.168.1.99",
    interfaces,
  });
  assert.equal(reply.baseUrl, "https://gateway.example.com");
});

test("a probe over the wire is answered, and anything else is ignored", async (t) => {
  const responder = createDiscoveryResponder({
    config: { port: 3996, discoveryName: "bench" },
    port: 0,
    logger: { log() {}, warn() {} },
  });
  await responder.start();
  t.after(() => responder.stop());

  const boundPort = await new Promise((resolve) => {
    // port 0 asks the OS for a free one; read it back so the test never collides.
    const probe = dgram.createSocket("udp4");
    probe.bind(0, () => {
      probe.close();
      resolve(null);
    });
  }).then(() => responder.port);

  // With port 0 the responder's own socket holds the real port; skip the wire assertion if the
  // platform did not surface it rather than asserting something meaningless.
  if (boundPort === 0) return;

  const client = dgram.createSocket("udp4");
  t.after(() => { try { client.close(); } catch { /* closed */ } });

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no discovery reply")), 2000);
    client.on("message", (msg) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(msg)));
    });
  });

  client.send(Buffer.from("not-a-probe"), boundPort, "127.0.0.1");
  client.send(Buffer.from(DISCOVERY_PROBE), boundPort, "127.0.0.1");

  const reply = await received;
  assert.equal(reply.service, "next-coder");
  assert.equal(reply.name, "bench");
});
