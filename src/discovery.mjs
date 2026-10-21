// LAN discovery, so a controller does not have to be told the gateway's address.
//
// The device is on the same network as the gateway, and typing a URL on a device with no keyboard
// is the single worst step in setup — it is where a typo strands a unit that is otherwise working.
// A broadcast probe removes the typing.
//
// Deliberately UDP broadcast rather than mDNS. mDNS would be more idiomatic, but a conformant
// responder is a large amount of protocol for one question, and the repo runs on zero runtime
// dependencies. `node:dgram` is core, and the exchange here is two datagrams:
//
//   device  -> 255.255.255.255:PORT   "AGENTCTL?"
//   gateway -> device                 {"service":"next-coder","baseUrl":"http://…", …}
//
// The reply is unicast back to the asker, so this never floods the network with announcements the
// way a periodic beacon would.

import dgram from "node:dgram";
import os from "node:os";

export const DISCOVERY_PORT = 3997;
export const DISCOVERY_PROBE = "AGENTCTL?";
// The service name is a wire value shared with the controller firmware. Firmware accepts both the
// current name and the legacy one, so a device keeps finding a gateway that has not been renamed.
export const DISCOVERY_SERVICE = "next-coder";

// The address a device on the LAN should use to reach us. `config.host` is usually 127.0.0.1 or
// 0.0.0.0, neither of which means anything to another machine, so the reply has to name a real
// interface address — chosen to match the subnet the probe arrived from, because a host with a
// Wi-Fi and an Ethernet interface has more than one right answer.
export function pickLanAddress(remoteAddress, interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      candidates.push(addr);
    }
  }
  if (candidates.length === 0) return null;

  const sameSubnet = candidates.find((addr) => sharesSubnet(addr, remoteAddress));
  return (sameSubnet ?? candidates[0]).address;
}

function sharesSubnet(addr, remoteAddress) {
  if (!addr.netmask || !remoteAddress) return false;
  const toInt = (ip) => ip.split(".").reduce((acc, part) => (acc << 8) + (Number(part) & 0xff), 0) >>> 0;
  try {
    const mask = toInt(addr.netmask);
    return (toInt(addr.address) & mask) === (toInt(remoteAddress) & mask);
  } catch {
    return false;
  }
}

export function buildDiscoveryReply({ config, remoteAddress, interfaces }) {
  const address = pickLanAddress(remoteAddress, interfaces);
  if (!address) return null;

  const scheme = config.publicBaseUrl?.startsWith("https://") ? "https" : "http";
  return {
    service: DISCOVERY_SERVICE,
    // A device seeing two gateways needs something to tell them apart on a 240px screen.
    name: config.discoveryName ?? os.hostname(),
    baseUrl: config.publicBaseUrl || `${scheme}://${address}:${config.port}`,
    port: config.port,
  };
}

// Answers probes until stop() is called. Never throws on a bad datagram: this listens on a port
// anything on the LAN can reach, so malformed input is expected rather than exceptional.
export function createDiscoveryResponder({ config, port = DISCOVERY_PORT, logger = console }) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let bound = false;

  socket.on("error", (error) => {
    logger.warn?.(`discovery responder error: ${error.message}`);
    try { socket.close(); } catch { /* already closing */ }
    bound = false;
  });

  socket.on("message", (message, rinfo) => {
    if (String(message).trim() !== DISCOVERY_PROBE) return;
    const reply = buildDiscoveryReply({ config, remoteAddress: rinfo.address });
    if (!reply) return;
    const payload = Buffer.from(JSON.stringify(reply));
    socket.send(payload, rinfo.port, rinfo.address, (error) => {
      if (error) logger.warn?.(`discovery reply failed: ${error.message}`);
    });
  });

  return {
    start() {
      return new Promise((resolve) => {
        socket.bind(port, () => {
          bound = true;
          try {
            socket.setBroadcast(true);
          } catch {
            // Not fatal: replies are unicast, and only the probe needs broadcast.
          }
          logger.log?.(`discovery responder listening on udp/${port}`);
          resolve();
        });
      });
    },
    stop() {
      if (!bound) return;
      bound = false;
      try { socket.close(); } catch { /* already closed */ }
    },
    get port() { return port; },
  };
}
