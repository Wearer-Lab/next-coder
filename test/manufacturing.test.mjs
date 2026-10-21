import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  alignmentPatternPositions,
  byteCapacity,
  encodeQr,
  pickVersion,
  renderQrAscii,
  renderQrSvg,
} from "../src/qrcode.mjs";
import {
  buildDeviceClaimPayload,
  buildDeviceClaimQrAscii,
  buildDeviceClaimQrSvg,
  buildDeviceClaimUrl,
  buildDeviceLabelSvg,
  buildFlashConfig,
  buildNvsSeedCsv,
  claimLabelFilename,
} from "../src/manufacturing.mjs";
import { loadConfig } from "../src/config.mjs";

const GATEWAY = "https://gateway.example.com";
const DEVICE_ID = "dev_0123456789ab";
const CLAIM_CODE = "ABCDE-FGHJK";
const CLAIM_URL = `${GATEWAY}/claim?device=${DEVICE_ID}&code=${CLAIM_CODE}`;

/**
 * Known-good symbol: byte-mode "HELLO WORLD" at version 1, level M, mask 4.
 * Transcribed from an independent encoder (node-qrcode 1.5.x, forced byte mode);
 * segno 1.6.6 produces the same modules for the same version/level/mask.
 */
const HELLO_WORLD_1M = [
  "111111101100101111111",
  "100000100001001000001",
  "101110100101001011101",
  "101110101001001011101",
  "101110101110101011101",
  "100000101001001000001",
  "111111101010101111111",
  "000000001001100000000",
  "100010111111011111001",
  "000100001011100001111",
  "001111110011011010010",
  "111110001100010000000",
  "111110101010101100110",
  "000000001010111101011",
  "111111101110101011010",
  "100000100101110110011",
  "101110101101011000110",
  "101110100100100011011",
  "101110100111000111000",
  "100000100001010000000",
  "111111101111111110101",
];

/**
 * SHA-256 of the module rows ("0"/"1" per row, joined with "\n") for the sample
 * claim URL at each error correction level. Every one of these matrices was
 * confirmed byte-identical to node-qrcode's output for the same version/mask.
 */
const CLAIM_URL_DIGESTS = {
  L: { version: 4, mask: 2, digest: "a51e552776bc9ae73997f230287055a4e8224a21e33b4e5c8440c6bc791ff2f1" },
  M: { version: 5, mask: 7, digest: "8eac7c6830591f199a06049a99ae65786866a4bee96abf47a8aa0c7103afa641" },
  Q: { version: 6, mask: 1, digest: "7f6af016aa80a0dc78f371c7e102ce3fe0622e4e25869d6c932193cbf8eeb7d3" },
  H: { version: 8, mask: 7, digest: "44c54c98aa1d063d1e46e793123b06ebc6f513bca64271fbc3d9471e4a1c2d5b" },
};

/* ================================================================== */
/* QR encoder                                                          */
/* ================================================================== */

test("encoder reproduces a known-good published symbol", () => {
  const qr = encodeQr("HELLO WORLD", { ecc: "M" });
  assert.equal(qr.version, 1);
  assert.equal(qr.ecc, "M");
  assert.equal(qr.mask, 4);
  assert.deepEqual(qr.toRowStrings(), HELLO_WORLD_1M);
});

test("encoder output for the claim URL is stable and matches the reference encoders", () => {
  for (const [ecc, expected] of Object.entries(CLAIM_URL_DIGESTS)) {
    const qr = encodeQr(CLAIM_URL, { ecc });
    assert.equal(qr.version, expected.version, `version for level ${ecc}`);
    assert.equal(qr.mask, expected.mask, `mask for level ${ecc}`);
    assert.equal(qr.size, qr.version * 4 + 17);
    const digest = createHash("sha256").update(qr.toRowStrings().join("\n")).digest("hex");
    assert.equal(digest, expected.digest, `module digest for level ${ecc}`);
  }
});

test("function patterns are placed where the spec requires", () => {
  for (const ecc of ["L", "M", "Q", "H"]) {
    const qr = encodeQr(CLAIM_URL, { ecc });
    const size = qr.size;

    // Three finder patterns, each a 7x7 concentric square with a light separator.
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(qr.get(ox + dx, oy + dy), ring !== 2, `finder at ${ox},${oy} module ${dx},${dy}`);
        }
      }
    }
    // The bottom-right corner holds an alignment pattern, not a fourth finder.
    assert.equal(qr.get(size - 7, size - 7), true, "alignment pattern centre");
    assert.equal(qr.get(size - 8, size - 7), false, "alignment pattern light ring");

    // Separators: the row/column just outside each finder is light.
    for (let i = 0; i < 8; i += 1) {
      assert.equal(qr.get(i, 7), false, "top-left separator row");
      assert.equal(qr.get(7, i), false, "top-left separator column");
      assert.equal(qr.get(size - 1 - i, 7), false, "top-right separator row");
      assert.equal(qr.get(7, size - 1 - i), false, "bottom-left separator column");
    }

    // Timing patterns alternate along row 6 and column 6.
    for (let i = 8; i < size - 8; i += 1) {
      assert.equal(qr.get(i, 6), i % 2 === 0, `horizontal timing at ${i}`);
      assert.equal(qr.get(6, i), i % 2 === 0, `vertical timing at ${i}`);
    }

    // The module above the bottom-left format copy is always dark.
    assert.equal(qr.get(8, size - 8), true);
  }
});

test("alignment pattern positions match the published table", () => {
  assert.deepEqual(alignmentPatternPositions(1), []);
  assert.deepEqual(alignmentPatternPositions(2), [6, 18]);
  assert.deepEqual(alignmentPatternPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPatternPositions(14), [6, 26, 46, 66]);
  assert.deepEqual(alignmentPatternPositions(21), [6, 28, 50, 72, 94]);
  assert.deepEqual(alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPatternPositions(40), [6, 30, 58, 86, 114, 142, 170]);

  // Every alignment pattern is a 5x5 concentric square.
  const qr = encodeQr(CLAIM_URL, { ecc: "H" });
  const positions = alignmentPatternPositions(qr.version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          assert.equal(qr.get(positions[i] + dx, positions[j] + dy), ring !== 1);
        }
      }
    }
  }
});

test("both format information copies carry the same spec-valid BCH codeword", () => {
  const seen = new Set();
  for (const ecc of ["L", "M", "Q", "H"]) {
    for (let mask = 0; mask < 8; mask += 1) {
      const qr = encodeQr(CLAIM_URL, { ecc, mask });
      const primary = readFormatBits(qr, "primary");
      const secondary = readFormatBits(qr, "secondary");
      assert.equal(primary, secondary, `format copies disagree for ${ecc}/${mask}`);

      const raw = primary ^ 0x5412; // unmask the format information
      assert.equal(bchRemainder(raw, 0x537, 15, 10), 0, `format BCH check failed for ${ecc}/${mask}`);
      assert.equal(raw >>> 10, expectedFormatPrefix(ecc, mask), `format payload wrong for ${ecc}/${mask}`);
      seen.add(primary);
    }
  }
  assert.equal(seen.size, 32, "the 32 format strings must be distinct");
  // ISO/IEC 18004: the format information code has minimum Hamming distance 7.
  const all = [...seen];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      assert.ok(popcount(all[i] ^ all[j]) >= 7, `format distance ${all[i]}/${all[j]}`);
    }
  }
});

test("version information is written for version 7 and up and passes its BCH check", () => {
  const small = encodeQr("small payload", { ecc: "L" });
  assert.ok(small.version < 7);

  const seen = [];
  for (const version of [7, 10, 20, 33, 40]) {
    const qr = encodeQr("x".repeat(byteCapacity(version, "L")), { ecc: "L", minVersion: version, maxVersion: version });
    assert.equal(qr.version, version);
    const bits = readVersionBits(qr);
    assert.equal(bits.topRight, bits.bottomLeft, "the two version blocks must agree");
    assert.equal(bchRemainder(bits.topRight, 0x1f25, 18, 12), 0, `version BCH check failed for v${version}`);
    assert.equal(bits.topRight >>> 12, version);
    seen.push(bits.topRight);
  }
  for (let i = 0; i < seen.length; i += 1) {
    for (let j = i + 1; j < seen.length; j += 1) {
      assert.ok(popcount(seen[i] ^ seen[j]) >= 8, "version information has minimum distance 8");
    }
  }
});

test("automatic version selection picks the smallest symbol that fits", () => {
  assert.equal(pickVersion(byteCapacity(1, "M"), "M"), 1);
  assert.equal(pickVersion(byteCapacity(1, "M") + 1, "M"), 2);
  assert.equal(pickVersion(byteCapacity(9, "Q"), "Q"), 9);
  assert.equal(pickVersion(byteCapacity(9, "Q") + 1, "Q"), 10); // char count widens to 16 bits
  assert.equal(encodeQr("x".repeat(byteCapacity(1, "L")), { ecc: "L" }).version, 1);
  assert.equal(encodeQr("x".repeat(byteCapacity(1, "L") + 1), { ecc: "L" }).version, 2);
  assert.throws(() => encodeQr("x".repeat(3000), { ecc: "H" }), /does not fit/u);
  assert.throws(() => encodeQr("x", { ecc: "Z" }), /error correction level/u);
  assert.throws(() => encodeQr("x", { mask: 9 }), /mask/u);
});

test("a decoder reading the finished matrix recovers the payload and clean syndromes", () => {
  // Single-block symbols, so the interleaved stream is the block itself. Every
  // step below (format info, mask, module walk, Reed-Solomon syndromes) is
  // re-derived from the spec here rather than reused from src/qrcode.mjs.
  const cases = [
    { text: "HELLO WORLD", ecc: "M", eccCodewords: 10 },
    { text: "dev_0123456789ab", ecc: "L", eccCodewords: 7 },
    { text: "claim ABCDE-FGHJK", ecc: "Q", eccCodewords: 13 },
    { text: "short", ecc: "H", eccCodewords: 17 },
    { text: "https://gw.example.com/claim?device=dev_1", ecc: "L", eccCodewords: 15 },
    { text: "Ünïcødé ✓ claim", ecc: "M", eccCodewords: 16 },
  ];
  for (const item of cases) {
    const qr = encodeQr(item.text, { ecc: item.ecc });
    const decoded = decodeSingleBlockQr(qr);
    assert.equal(decoded.text, item.text, `payload round-trip for ${JSON.stringify(item.text)}`);
    assert.equal(decoded.ecc, item.ecc);
    assert.equal(decoded.mask, qr.mask);
    assert.ok(
      decoded.zeroSyndromes >= item.eccCodewords,
      `expected at least ${item.eccCodewords} zero syndromes, saw ${decoded.zeroSyndromes}`,
    );
  }
});

test("every mask produces a decodable symbol", () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const qr = encodeQr("HELLO WORLD", { ecc: "M", mask });
    assert.equal(qr.mask, mask);
    const decoded = decodeSingleBlockQr(qr);
    assert.equal(decoded.mask, mask);
    assert.equal(decoded.text, "HELLO WORLD");
  }
});

test("SVG renderer reproduces the matrix and keeps a quiet zone", () => {
  const qr = encodeQr(CLAIM_URL, { ecc: "M" });
  const svg = renderQrSvg(qr, { scale: 5, border: 4, title: "Claim device" });
  const dimension = (qr.size + 8) * 5;

  assert.ok(svg.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
  assert.ok(svg.includes(`viewBox="0 0 ${dimension} ${dimension}"`));
  assert.ok(svg.includes(`width="${dimension}"`));
  assert.ok(svg.includes("<title>Claim device</title>"));
  assert.ok(svg.trimEnd().endsWith("</svg>"));

  const painted = paintedModulesFromSvg(svg, 5, 4, qr.size);
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      assert.equal(painted.has(`${x},${y}`), qr.get(x, y), `svg module ${x},${y}`);
    }
  }
  assert.equal(renderQrSvg(CLAIM_URL, { ecc: "M", scale: 5, border: 4, title: "Claim device" }), svg);
});

test("ASCII renderers reproduce the matrix for terminal use", () => {
  const qr = encodeQr(CLAIM_URL, { ecc: "M" });
  const border = 4;

  const half = renderQrAscii(qr, { style: "half", border }).split("\n").filter((line) => line !== "");
  assert.equal(half.length, Math.ceil((qr.size + border * 2) / 2));
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      const glyph = half[Math.floor((y + border) / 2)][x + border];
      const isTopHalf = (y + border) % 2 === 0;
      const dark = glyph === "█" || (isTopHalf ? glyph === "▀" : glyph === "▄");
      assert.equal(dark, qr.get(x, y), `half-block module ${x},${y}`);
    }
  }
  assert.equal(half[0].trim(), "", "top quiet zone must be blank");

  const block = renderQrAscii(qr, { style: "block", border }).split("\n").filter((line) => line !== "");
  assert.equal(block.length, qr.size + border * 2);
  assert.equal(block[0].length, (qr.size + border * 2) * 2);
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      assert.equal(block[y + border][(x + border) * 2] === "█", qr.get(x, y), `block module ${x},${y}`);
    }
  }

  const ascii = renderQrAscii(qr, { style: "ascii", border });
  assert.ok(ascii.includes("##"));
  assert.ok(!/[^#\s]/u.test(ascii));

  const ansi = renderQrAscii(qr, { style: "half", border, ansi: true });
  assert.ok(ansi.includes("[30;47m"), "ANSI mode forces dark-on-light");
  assert.ok(ansi.includes("[0m"));
});

test("OpenCV decodes the generated claim QR codes", { skip: externalDecoderSkipReason() }, () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // the factory claim-code alphabet
  const samples = [{ text: "HELLO WORLD", ecc: "M" }];
  for (let index = 0; index < 24; index += 1) {
    let claimCode = "";
    for (let position = 0; position < 10; position += 1) {
      claimCode += alphabet[(index * 31 + position * 17) % alphabet.length];
      if (position === 4) claimCode += "-";
    }
    samples.push({
      text: buildDeviceClaimUrl({
        gatewayBaseUrl: index % 2 === 0 ? GATEWAY : "https://ctrl.acme-robotics.io/gw",
        deviceId: `dev_${(index * 7919).toString(36).padStart(12, "0")}`,
        claimCode,
      }),
      ecc: ["L", "M", "Q", "H"][index % 4],
    });
  }
  const payload = samples.map(({ text, ecc }) => ({ text, rows: encodeQr(text, { ecc }).toRowStrings() }));
  const result = runExternalDecoder(payload);
  assert.deepEqual(result.failures, [], "OpenCV failed to decode these symbols");
  assert.equal(result.decoded, payload.length);
});

/* ================================================================== */
/* Manufacturing helpers                                               */
/* ================================================================== */

test("claim URL carries the gateway, device id and claim code", () => {
  assert.equal(
    buildDeviceClaimUrl({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, claimCode: CLAIM_CODE }),
    CLAIM_URL,
  );
  // Trailing slashes and lowercase claim codes are normalised.
  assert.equal(
    buildDeviceClaimUrl({ gatewayBaseUrl: `${GATEWAY}///`, deviceId: DEVICE_ID, claimCode: "abcde-fghjk" }),
    CLAIM_URL,
  );
  assert.equal(
    buildDeviceClaimUrl({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, claimCode: CLAIM_CODE, claimPath: "devices/claim" }),
    `${GATEWAY}/devices/claim?device=${DEVICE_ID}&code=${CLAIM_CODE}`,
  );

  assert.throws(() => buildDeviceClaimUrl({ gatewayBaseUrl: "", deviceId: DEVICE_ID, claimCode: CLAIM_CODE }), /gatewayBaseUrl/u);
  assert.throws(() => buildDeviceClaimUrl({ gatewayBaseUrl: "not a url", deviceId: DEVICE_ID, claimCode: CLAIM_CODE }), /Invalid URL/u);
  assert.throws(() => buildDeviceClaimUrl({ gatewayBaseUrl: GATEWAY, deviceId: "dev id", claimCode: CLAIM_CODE }), /deviceId/u);
  assert.throws(() => buildDeviceClaimUrl({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, claimCode: "not/a/code" }), /claimCode/u);
});

test("claim payload is what the label and the QR both describe", () => {
  const payload = buildDeviceClaimPayload({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    claimCode: "abcde-fghjk",
    label: "  Next Coder 001  ",
  });
  assert.deepEqual(payload, {
    deviceId: DEVICE_ID,
    claimCode: CLAIM_CODE,
    label: "Next Coder 001",
    claimUrl: CLAIM_URL,
  });
});

test("device claim QR SVG encodes exactly the claim URL", () => {
  const svg = buildDeviceClaimQrSvg({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, claimCode: CLAIM_CODE });
  assert.ok(svg.startsWith("<?xml"));
  assert.ok(svg.includes(`<title>Claim ${DEVICE_ID}</title>`));
  assert.equal(svg.includes(CLAIM_CODE), false, "the QR itself must not leak the code as text");

  const qr = encodeQr(CLAIM_URL, { ecc: "M" });
  const painted = paintedModulesFromSvg(svg, 6, 4, qr.size);
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      assert.equal(painted.has(`${x},${y}`), qr.get(x, y));
    }
  }
  assert.equal(decodeSingleBlockQr(encodeQr(CLAIM_URL, { ecc: "L", minVersion: 4, maxVersion: 4 })).text, CLAIM_URL);
});

test("device label SVG pairs the QR with human-readable identifiers", () => {
  const svg = buildDeviceLabelSvg({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    claimCode: CLAIM_CODE,
    label: "Next Coder 007",
  });
  assert.ok(svg.startsWith("<?xml"));
  assert.ok(svg.includes("Next Coder 007"));
  assert.ok(svg.includes(DEVICE_ID));
  assert.ok(svg.includes(CLAIM_CODE));
  assert.ok(svg.includes("<path d=\"M"), "label embeds the QR path");
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.equal((svg.match(/<svg/gu) ?? []).length, 1, "label must be a single SVG document");
});

test("label SVG escapes untrusted label text", () => {
  const svg = buildDeviceLabelSvg({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    claimCode: CLAIM_CODE,
    label: "<script>alert('x')</script>",
  });
  assert.equal(svg.includes("<script>"), false);
  assert.ok(svg.includes("&lt;script&gt;"));
});

test("terminal QR for a device is scannable-shaped and label filenames are stable", () => {
  const ascii = buildDeviceClaimQrAscii({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, claimCode: CLAIM_CODE });
  const lines = ascii.split("\n").filter((line) => line !== "");
  const qr = encodeQr(CLAIM_URL, { ecc: "M" });
  assert.equal(lines.length, Math.ceil((qr.size + 8) / 2));
  assert.equal(lines[0].trim(), "");
  assert.ok(lines.some((line) => line.includes("█")));

  assert.equal(claimLabelFilename(DEVICE_ID), `${DEVICE_ID}.claim-label.svg`);
});

test("flash config still builds alongside the QR artefacts", () => {
  const config = buildFlashConfig({ gatewayBaseUrl: GATEWAY, deviceId: DEVICE_ID, deviceSecret: "s3cr3t" });
  assert.ok(config.includes(`#define DEVICE_ID "${DEVICE_ID}"`));
  assert.ok(config.includes(`#define GATEWAY_BASE_URL "${GATEWAY}"`));
  assert.ok(config.includes("#define INSECURE_SKIP_TLS_VERIFY 0"));
  assert.ok(config.includes('#define GATEWAY_TLS_ROOT_CA_PEM ""'));
  // Break 1: a factory-baked SSID cannot match the customer's network, so no shipped unit could
  // ever connect. Wi-Fi is the owner's to supply through the on-device portal.
  assert.doesNotMatch(config, /#define\s+WIFI_SSID/u);
  assert.doesNotMatch(config, /#define\s+WIFI_PASSWORD/u);
});

test("flash config carries rotatable TLS roots and requires an explicit insecure bench override", () => {
  const root = "-----BEGIN CERTIFICATE-----\ncurrent\n-----END CERTIFICATE-----";
  const next = "-----BEGIN CERTIFICATE-----\nnext\n-----END CERTIFICATE-----";
  const secure = buildFlashConfig({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    deviceSecret: "s3cr3t",
    gatewayTlsRootCaPem: root,
    gatewayTlsNextRootCaPem: next,
  });
  assert.ok(secure.includes('#define GATEWAY_TLS_ROOT_CA_PEM "-----BEGIN CERTIFICATE-----\\ncurrent\\n-----END CERTIFICATE-----"'));
  assert.ok(secure.includes('#define GATEWAY_TLS_NEXT_ROOT_CA_PEM "-----BEGIN CERTIFICATE-----\\nnext\\n-----END CERTIFICATE-----"'));
  assert.ok(secure.includes("#define INSECURE_SKIP_TLS_VERIFY 0"));

  const bench = buildFlashConfig({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    deviceSecret: "s3cr3t",
    allowInsecureTls: true,
  });
  assert.ok(bench.includes("#define INSECURE_SKIP_TLS_VERIFY 1"));
});

test("one-line env PEM values become valid multiline manufacturing roots", () => {
  const config = loadConfig({ GATEWAY_TLS_ROOT_CA_PEM: "BEGIN\\nroot\\nEND\\n" });
  assert.equal(config.gatewayTlsRootCaPem, "BEGIN\nroot\nEND\n");
  const header = buildFlashConfig({
    gatewayBaseUrl: GATEWAY,
    deviceId: DEVICE_ID,
    deviceSecret: "s3cr3t",
    gatewayTlsRootCaPem: config.gatewayTlsRootCaPem,
  });
  assert.ok(header.includes('#define GATEWAY_TLS_ROOT_CA_PEM "BEGIN\\nroot\\nEND\\n"'));
});

test("the NVS seed carries identity and the claim code, in nvs_partition_gen's format", () => {
  const csv = buildNvsSeedCsv({
    deviceId: DEVICE_ID,
    deviceSecret: "s3cr3t",
    gatewayBaseUrl: GATEWAY,
    claimCode: "QFMBF-EQ5VD",
    claimCodeExpiresAt: "2026-09-06T10:39:11.242Z",
  });
  const lines = csv.trim().split("\n");

  assert.equal(lines[0], "key,type,encoding,value");
  assert.equal(lines[1], "agentctl,namespace,,", "the namespace row must match DeviceStore's");
  assert.ok(lines.includes(`dev_id,data,string,${DEVICE_ID}`));
  assert.ok(lines.includes("dev_secret,data,string,s3cr3t"));
  assert.ok(lines.includes(`gw_url,data,string,${GATEWAY}`));

  // Found on hardware: without this the unit boots showing "No code" while the printed label
  // carries the real one, because the gateway will not reissue a still-live code's plaintext.
  assert.ok(lines.includes("claim_code,data,string,QFMBF-EQ5VD"));
  assert.ok(lines.includes("claim_exp,data,string,2026-09-06T10:39:11.242Z"));

  // Every NVS key has to fit the 15-character limit or the partition tool rejects the row.
  for (const line of lines.slice(2)) {
    assert.ok(line.split(",")[0].length <= 15, `${line} exceeds the NVS key length limit`);
  }

  // Wi-Fi stays absent: it belongs to the owner and the factory cannot know it.
  assert.doesNotMatch(csv, /wifi_ssid|wifi_pass/u);
});

test("an NVS seed without a claim code simply omits those rows", () => {
  const csv = buildNvsSeedCsv({ deviceId: DEVICE_ID, deviceSecret: "s3cr3t" });
  assert.doesNotMatch(csv, /claim_code|claim_exp/u);
  assert.ok(csv.includes(`dev_id,data,string,${DEVICE_ID}`));
});

test("an NVS seed without an identity is refused rather than silently half-written", () => {
  assert.throws(() => buildNvsSeedCsv({ deviceId: DEVICE_ID, gatewayBaseUrl: GATEWAY }), /deviceId and deviceSecret/u);
  assert.throws(() => buildNvsSeedCsv({ deviceSecret: "s3cr3t" }), /deviceId and deviceSecret/u);
});

test("a value containing a comma or quote is CSV-quoted, not left to corrupt the row", () => {
  const csv = buildNvsSeedCsv({
    deviceId: DEVICE_ID,
    deviceSecret: 'we,ird"secret',
    gatewayBaseUrl: GATEWAY,
  });
  assert.ok(csv.includes('dev_secret,data,string,"we,ird""secret"'));
});

/* ================================================================== */
/* Test-only QR reader (spec re-derived, independent of src/qrcode.mjs) */
/* ================================================================== */

const MASK_PREDICATES = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const ECC_BY_FORMAT_BITS = { 1: "L", 0: "M", 3: "Q", 2: "H" };

function readFormatBits(qr, copy) {
  const size = qr.size;
  let bits = 0;
  for (let index = 0; index < 15; index += 1) {
    let x;
    let y;
    if (copy === "primary") {
      if (index <= 5) [x, y] = [8, index];
      else if (index === 6) [x, y] = [8, 7];
      else if (index === 7) [x, y] = [8, 8];
      else if (index === 8) [x, y] = [7, 8];
      else [x, y] = [14 - index, 8];
    } else if (index < 8) {
      [x, y] = [size - 1 - index, 8];
    } else {
      [x, y] = [8, size - 15 + index];
    }
    if (qr.get(x, y)) bits |= 1 << index;
  }
  return bits;
}

function readVersionBits(qr) {
  const size = qr.size;
  let topRight = 0;
  let bottomLeft = 0;
  for (let index = 0; index < 18; index += 1) {
    const a = size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    if (qr.get(a, b)) topRight |= 1 << index;
    if (qr.get(b, a)) bottomLeft |= 1 << index;
  }
  return { topRight, bottomLeft };
}

function isFunctionModule(x, y, size, version) {
  if (x === 6 || y === 6) return true; // timing
  if (x < 9 && y < 9) return true; // top-left finder + format
  if (x >= size - 8 && y < 9) return true; // top-right finder + format
  if (x < 9 && y >= size - 8) return true; // bottom-left finder + format
  if (version >= 7) {
    if (x >= size - 11 && x < size - 8 && y < 6) return true;
    if (y >= size - 11 && y < size - 8 && x < 6) return true;
  }
  const positions = alignmentPatternPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(x - positions[i]) <= 2 && Math.abs(y - positions[j]) <= 2) return true;
    }
  }
  return false;
}

function decodeSingleBlockQr(qr) {
  const size = qr.size;
  const version = (size - 17) / 4;
  const format = readFormatBits(qr, "primary") ^ 0x5412;
  const mask = format >>> 10 & 0b111;
  const ecc = ECC_BY_FORMAT_BITS[(format >>> 13) & 0b11];
  const unmask = MASK_PREDICATES[mask];

  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (isFunctionModule(x, y, size, version)) continue;
        bits.push(qr.get(x, y) !== unmask(x, y));
      }
    }
  }

  const codewords = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | (bits[index + offset] ? 1 : 0);
    codewords.push(value);
  }

  const mode = readBits(bits, 0, 4);
  assert.equal(mode, 0b0100, "expected byte mode");
  const countBits = version <= 9 ? 8 : 16;
  const length = readBits(bits, 4, countBits);
  const bytes = [];
  for (let index = 0; index < length; index += 1) bytes.push(readBits(bits, 4 + countBits + index * 8, 8));

  return {
    version,
    ecc,
    mask,
    text: new TextDecoder().decode(Uint8Array.from(bytes)),
    zeroSyndromes: countZeroSyndromes(codewords),
  };
}

function readBits(bits, offset, length) {
  let value = 0;
  for (let index = 0; index < length; index += 1) value = (value << 1) | (bits[offset + index] ? 1 : 0);
  return value;
}

// Independent GF(256) arithmetic for the syndrome check.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value = (value << 1) ^ (value & 0x80 ? 0x11d : 0);
    value &= 0xff;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Number of leading syndromes S_0.. that evaluate to zero (>= 2t for a valid codeword). */
function countZeroSyndromes(codewords) {
  let zero = 0;
  for (let power = 0; power < 40; power += 1) {
    let accumulator = 0;
    for (const codeword of codewords) accumulator = gfMul(accumulator, EXP[power]) ^ codeword;
    if (accumulator !== 0) break;
    zero += 1;
  }
  return zero;
}

function bchRemainder(value, generator, totalBits, checkBits) {
  let remainder = value;
  for (let index = totalBits - 1; index >= checkBits; index -= 1) {
    if (remainder & (1 << index)) remainder ^= generator << (index - checkBits);
  }
  return remainder;
}

function expectedFormatPrefix(ecc, mask) {
  const formatBits = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[ecc];
  return (formatBits << 3) | mask;
}

function popcount(value) {
  let count = 0;
  let rest = value;
  while (rest !== 0) {
    count += rest & 1;
    rest >>>= 1;
  }
  return count;
}

function paintedModulesFromSvg(svg, scale, border, size) {
  const path = /<path d="([^"]*)"/u.exec(svg);
  assert.ok(path, "svg must contain a module path");
  const painted = new Set();
  const runs = path[1].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/gu);
  for (const [, rawX, rawY, rawWidth, rawHeight] of runs) {
    const x = Number(rawX);
    const y = Number(rawY);
    const width = Number(rawWidth);
    assert.equal(Number(rawHeight), scale, "each run is one module tall");
    assert.equal(x % scale, 0);
    assert.equal(y % scale, 0);
    const moduleX = x / scale - border;
    const moduleY = y / scale - border;
    assert.ok(moduleX >= 0 && moduleY >= 0 && moduleY < size, "runs stay inside the quiet zone");
    assert.ok(moduleX + width / scale <= size, "runs stay inside the symbol");
    for (let offset = 0; offset < width / scale; offset += 1) painted.add(`${moduleX + offset},${moduleY}`);
  }
  return painted;
}

/* ------------------------------------------------------------------ */
/* Optional third-party decoder (OpenCV via python3)                    */
/* ------------------------------------------------------------------ */

const EXTERNAL_DECODER_SCRIPT = `
import json, sys
import numpy as np
import cv2

items = json.load(sys.stdin)
# QRCodeDetectorAruco localises finder patterns far more reliably than the
# legacy detector on synthetic images; fall back when the build predates it.
detector = cv2.QRCodeDetectorAruco() if hasattr(cv2, "QRCodeDetectorAruco") else cv2.QRCodeDetector()
failures = []
decoded = 0
for item in items:
    rows = item["rows"]
    size = len(rows)
    border, scale = 8, 10
    matrix = np.array([[0 if c == "1" else 255 for c in r] for r in rows], dtype=np.uint8)
    canvas = np.full((size + 2 * border, size + 2 * border), 255, dtype=np.uint8)
    canvas[border:border + size, border:border + size] = matrix
    image = np.kron(canvas, np.ones((scale, scale), dtype=np.uint8))
    try:
        data, _, _ = detector.detectAndDecode(image)
    except Exception:
        data = ""
    if data == item["text"]:
        decoded += 1
    else:
        failures.append({"text": item["text"][:60], "decoded": data[:60]})
print(json.dumps({"decoded": decoded, "failures": failures}))
`;

function externalDecoderSkipReason() {
  const probe = spawnSync("python3", ["-c", "import cv2, numpy"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return "python3 with opencv/numpy is not available";
  return false;
}

function runExternalDecoder(payload) {
  const result = spawnSync("python3", ["-c", EXTERNAL_DECODER_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `external decoder failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
