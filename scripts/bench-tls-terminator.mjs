#!/usr/bin/env node
// Local bench TLS terminator: terminates TLS with a locally generated CA-signed certificate for
// the gateway's LAN address and pipes the plaintext bytes to the node gateway unchanged.
//
// Bench-only operator tool. It exists so secure-release firmware (which refuses plaintext LAN
// URLs and refuses unverified TLS by design) can exercise real verified HTTPS against a
// self-hosted gateway without deploying the full cloud stack. Production terminates TLS in front
// of the gateway; this does the same locally, not in the product.
//
// Usage: node scripts/bench-tls-terminator.mjs
// Requires: BENCH_TLS_CERT, BENCH_TLS_KEY, optional BENCH_TLS_TARGET (default
// http://127.0.0.1:3996) and BENCH_TLS_PORT (default 4443).

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const { URL } = globalThis;
const certPem = process.env.BENCH_TLS_CERT;
const keyPem = process.env.BENCH_TLS_KEY;
if (!certPem || !keyPem) {
  console.error("bench TLS terminator requires BENCH_TLS_CERT and BENCH_TLS_KEY");
  process.exit(1);
}
const target = process.env.BENCH_TLS_TARGET || "http://127.0.0.1:3996";
const targetUrl = new URL(target);
const targetPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
const port = Number(process.env.BENCH_TLS_PORT || 4443);

const server = tls.createServer(
  { cert: fs.readFileSync(certPem), key: fs.readFileSync(keyPem) },
  (client) => {
    const upstream = net.connect({ host: targetUrl.hostname, port: targetPort });
    client.pipe(upstream);
    upstream.pipe(client);

    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  },
);

server.on("tlsClientError", (error) => {
  console.warn("bench TLS terminator: client handshake rejected:", error.message);
});
server.on("error", (error) => {
  console.error("bench TLS terminator: server error:", error.message);
  process.exitCode = 1;
});
server.listen(port, () => {
  console.info(`bench TLS terminator: https://0.0.0.0:${port} -> ${target} (byte pipe, headers unchanged)`);
});
