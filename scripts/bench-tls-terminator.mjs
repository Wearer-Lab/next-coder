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

    // The gateway builds absolute URLs from the request it receives, and the artifact URL inside
    // an OTA manifest is signed over that origin. Terminating TLS and then forwarding the bytes
    // unchanged tells the gateway the request was http, so the manifest would hand the device an
    // http:// artifact URL — and a device with TLS verification on refuses that download for being
    // insecure, which is exactly the failure this terminator exists to avoid.
    //
    // One header fixes it, and it is the header any reverse proxy in front of TLS already sets.
    let headComplete = false;
    let buffered = Buffer.alloc(0);
    client.on("data", (chunk) => {
      if (headComplete) {
        upstream.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        // A request head that never ends is not a request. Forward what we have rather than
        // buffering without bound.
        if (buffered.length > 64 * 1024) {
          upstream.write(buffered);
          buffered = Buffer.alloc(0);
          headComplete = true;
        }
        return;
      }
      const head = buffered.subarray(0, end).toString("latin1");
      const rest = buffered.subarray(end + 4);
      const lines = head.split("\r\n").filter((line) => !/^x-forwarded-proto\s*:/iu.test(line));
      lines.splice(1, 0, "x-forwarded-proto: https");
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (rest.length > 0) upstream.write(rest);
      buffered = Buffer.alloc(0);
      headComplete = true;
    });

    upstream.pipe(client);

    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    // A half-close, not a destroy. When the upstream has sent its last byte it closes its
    // side; tearing the whole socket down at that point throws away whatever was still sitting
    // in the buffers, and a client downloading an artifact sees a short body and reports it as an
    // incomplete download. end() flushes what is left and then says goodbye.
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
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
  console.info(`bench TLS terminator: https://0.0.0.0:${port} -> ${target} (byte pipe, x-forwarded-proto: https)`);
});
