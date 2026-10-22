# Units for this board: what a fresh unit carries, and how a staging unit is made

This is the factory-side counterpart to the gateway's contract. It answers three questions that
otherwise get answered by accident, on a bench, with a board that has to be reflashed:

1. What state does a unit that just came out of the box hold, and where does each piece come from?
2. What does the long-press reset clear, and what does it deliberately leave alone?
3. What does a unit pointed at the Cloudflare staging gateway need that a bench unit does not?

Nothing here is board-specific except the seed file it produces. The behaviour lives in
`firmware/shared/NextCoderCore` (`DeviceStore`, `Provisioning`, `GatewayClient`).

## 1. The state a unit holds

Every writable value lives in one NVS namespace, `agentctl`. Nothing about a unit's network or
identity is compiled into the image; the image is the same for a whole batch and the per-unit part
is a small data partition.

### Compiled into the image (the build seed, `include/controller_config.h`)

| Value | Key | Notes |
|---|---|---|
| Gateway URL (factory default) | `GATEWAY_BASE_URL` | Only used when NVS holds no gateway URL. |
| Device id / secret (bench only) | `DEVICE_ID`, `DEVICE_SECRET` | The bench path. A factory unit gets these in NVS instead, and `seedIdentityIfEmpty()` refuses to overwrite a provisioned unit. |
| Hardware model | `HARDWARE_MODEL` | `ips28-esp32-s3r8`. This is the firmware-manifest matching key; changing it orphans the unit from its release channel. |
| Firmware version | `FIRMWARE_VERSION` | What the unit reports in its heartbeat and what the gateway compares releases against. |
| OTA flags | `ENABLE_OTA_APPLY`, `REQUIRE_OTA_SIGNATURE` | Both on in `hosyond-es3c28p-controller`. |
| OTA verifier key | `OTA_MANIFEST_VERIFY_KEY` | Must be the gateway's `OTA_SIGNING_KEY`, byte for byte. See §4. |
| TLS roots | `GATEWAY_TLS_ROOT_CA_PEM`, `GATEWAY_TLS_NEXT_ROOT_CA_PEM` | The anchors the unit will accept a gateway certificate from. |
| TLS switch | `INSECURE_SKIP_TLS_VERIFY` | `0` in any product build; the release environment forces it to `0` regardless of the seed. |
| Pin map, audio bus, display geometry | board macros | The seed generator rewrites the named macros only, so this block is preserved. |

### Held in NVS (namespace `agentctl`)

| Key | Meaning | Written by |
|---|---|---|
| `dev_id` | Device id | Factory (NVS partition) or the bench seed |
| `dev_secret` | Device secret | Factory (NVS partition) or the bench seed |
| `cred_ver` | Credential version | Device, on rotation |
| `cred_psec`, `cred_rid`, `cred_pver`, `cred_purp` | Pending credential rotation (secret, rotation id, version, purpose) | Device, during the rotation handshake |
| `gw_url` | The gateway this unit talks to | Factory seed, or the owner in the setup portal |
| `gw_profiles`, `gw_rev`, `gw_active`, `gw_pending`, `gw_purl`, `gw_prev`, `gw_state`, `gw_error` | Gateway profile switch journal | DeviceStore only; the shared client never populates it on this board (the profile protocol is not ported), so these stay empty |
| `wifi_ssid`, `wifi_pass` | The owner's network | The owner, through the SoftAP portal |
| `claim_code`, `claim_exp` | The single-use claim code and its expiry | Factory seed, or the device asking `POST /v1/device/setup-code` |
| `cfg_cache` | Last good `GET /v1/device/config` | Device, so a boot with no gateway still renders |
| `req_id`, `req_hash` | One uncertain agent write, as a fingerprint | Device |
| `ota_from`, `ota_target`, `ota_boots`, `ota_bver` | OTA attempt marker and boot counter | Device, after a verified image is committed |

**Not in NVS at all:** the environment and the thread. They live on the gateway, in the device
record's config, and the unit reads them from `GET /v1/device/config`. `ENVIRONMENT_ID` and
`THREAD_ID` in the seed are inert on this board — only the CrowPanel firmware reads them.

**Dead key:** the factory NVS seed writes `hw_model`, and no firmware reads it. The unit reports the
board it was *compiled* for.

## 2. The life of a factory-fresh unit

```
factory            flash the image, write the NVS partition (identity, gateway URL, claim code)
boot               no Wi-Fi in NVS -> SoftAP "agent-ctl-XXXX" comes up, portal at 192.168.4.1
owner              joins the AP, picks the network, enters the password; the gateway URL field is
                   pre-filled and may be corrected
boot               Wi-Fi saved -> station connects -> heartbeat -> GET /v1/device/config returns 403
                   -> the unit is authenticated but unowned -> it shows its cached claim code
owner              signs in to the console and redeems the code (POST /v1/devices/claim)
boot               the next GET /v1/device/config returns 200 -> claimed; the claim code is cleared
                   from NVS; the unit is live
```

The claim code has to exist somewhere the owner can read it. The gateway stores only its hash, so
the plaintext exists exactly once, at issue. The factory seed carries it into NVS (`claim_code`,
`claim_exp`) — that is what keeps the code on the box and the code on the screen the same code.
A unit with no cached code asks `POST /v1/device/setup-code` with `{"rotate": true}` and is told a
new one; the menu item for that is on the device.

A unit with **no identity at all** is terminal: the gateway cannot authenticate it, and it cannot
ask for a claim code either. The screen says "Factory flash needed". Identity comes from the
factory NVS partition, or from the build seed on the bench.

## 3. What the reset gesture does, and does not do

**Tap BOOT** — reopens the setup portal without wiping anything. This is the escape hatch for a
wrong gateway URL: the portal has a *Gateway URL* field, so the gateway can be corrected without
reflashing and without losing the Wi-Fi. The portal only offers "Find gateway on this network" and
"Done" when the unit still has Wi-Fi credentials.

**Hold BOOT for 10 s** — `resetForProvisioning()`. It clears:

- the Wi-Fi SSID and password,
- the cached configuration,
- the cached claim code and its expiry,
- the pending request fingerprint.

It **keeps**:

- the device id and secret,
- the gateway URL and the gateway profile journal,
- the credential version and any pending rotation,
- the OTA attempt markers.

That is deliberate. The unit is still the same unit; detaching it from its account is the owner's
action (`resetDeviceForTransfer` on the gateway), not the hardware's — otherwise anyone holding a
stolen controller could unbind it from its owner.

**`wipeToFactoryState()`** additionally clears the gateway URL and the profile journal, returning
the unit to the state it left the factory in; the build-time gateway default comes back on the
next boot. It also keeps the identity, deliberately: erasing the secret leaves a unit that cannot
authenticate and cannot be recovered without a flashing station, which is a brick in the owner's
hands. Only the CrowPanel firmware calls it today; this board has no gesture for it.

**Erasing the NVS partition** removes everything, including the identity. The unit then re-seeds
from the build seed, if that seed carries a usable identity — `seedIdentityIfEmpty()` refuses any
id or secret containing `replace_me`. That is why a bench seed holding a *retired* device id is a
trap: erase the NVS and the unit comes up as that retired device, which the gateway answers 401 to.

## 4. The OTA verifier key

The manifest the gateway publishes is signed with `OTA_SIGNING_KEY`; the unit recomputes the HMAC
over its own canonical rendering of the manifest and compares. Three things have to agree:

1. the canonical form — the gateway sorts the manifest keys, the unit emits them in the same
   alphabetical order (verified byte for byte by `scripts/verify-ota-manifest.mjs`);
2. the key — the unit's `OTA_MANIFEST_VERIFY_KEY` must be the gateway's `OTA_SIGNING_KEY`, byte for
   byte, including any quoting;
3. the flags — `REQUIRE_OTA_SIGNATURE=1` turns the check on, and `ENABLE_OTA_APPLY=1` lets the unit
   write flash.

If the key is missing, the unit refuses every manifest and reports `manifest signature invalid`. The
status report itself still returns 200 — the gateway accepts the report and stores the failure
detail in the device's firmware policy — so the failure looks like a 200 and a rejection.

The key belongs to the gateway environment, not to the unit. It is supplied at build time:

```
NEXT_CODER_OTA_VERIFY_KEY=<the gateway's OTA_SIGNING_KEY> pio run -e hosyond-es3c28p-controller
```

and it overrides the seed. The seed's own `OTA_MANIFEST_VERIFY_KEY` is honoured as well — the
shared client resolves it after the board configuration is visible, so both routes work.

**Careful with the shell.** A secret written as `OTA_SIGNING_KEY="quoted"` in `.env` carries the
quotes as part of its value. Node's `--env-file` keeps them; `grep | cut` keeps them; but
`source .env` in a shell *strips* them. A key that loses its quotes on the way to the compiler is
a different key, and every manifest is rejected.

## 5. A staging unit

A staging unit is a bench unit pointed at the Cloudflare staging origin. The identity, the claim
code and the owner claim are the same as for any unit; four things change.

### The gateway URL and the trust anchor

```
https://agent-controller-cloud-staging.sergio-williomes.workers.dev
```

The origin serves a public chain whose leaf rotates:

```
CN=sergio-williomes.workers.dev            (leaf, 90 days)
  <- C=US, O=Google Trust Services, CN=WE1 (intermediate)
    <- C=US, O=Google Trust Services LLC, CN=GTS Root R4   (cross-signed by GlobalSign Root CA)
```

The last certificate the server sends is *cross-signed*: same subject and public key as the real
GTS Root R4, but issued by GlobalSign Root CA. A verifier therefore needs **two** anchors, and the
firmware has exactly two slots for them:

- `GATEWAY_TLS_ROOT_CA_PEM` — the self-signed **GTS Root R4**, for a verifier that terminates the
  chain at the trust store;
- `GATEWAY_TLS_NEXT_ROOT_CA_PEM` — **GlobalSign Root CA**, for a verifier that follows the served
  chain to its end.

Generate both, and the whole seed, with:

```
node scripts/build-device-seed.mjs \
  --board firmware/Hosyond-ESP32-S3-2.8-Touchscreen \
  --gateway https://agent-controller-cloud-staging.sergio-williomes.workers.dev \
  --version 0.2.3 \
  --clear-ota-key \
  --out firmware/Hosyond-ESP32-S3-2.8-Touchscreen/include/controller_config.staging.h
```

The script fetches the chain from the origin, reports it, selects the anchors from the operating
system trust store (or from `--anchor <root.pem>`), and rewrites only the named macros in the
board's seed — the pin map, audio bus and display geometry are preserved. It never prints a key.

### The OTA verifier key

The staging control plane signs with its own `OTA_SIGNING_KEY`. Put that value in the seed:

```
node scripts/build-device-seed.mjs ... --ota-key-from-env
```

with `OTA_SIGNING_KEY` set to the staging control plane's value (not the bench gateway's).

### The factory registration and the claim

```
NEXT_CODER_URL=https://agent-controller-cloud-staging.sergio-williomes.workers.dev \
FACTORY_TOKEN=<the staging control plane's factory token> \
HARDWARE_MODEL=ips28-esp32-s3r8 \
OUTPUT_DIR=.manufacturing/staging \
node scripts/manufacture-batch.mjs
```

That writes one NVS seed per unit (`<device-id>.nvs.csv`), one claim label, and the batch manifest.
Flash the image, write the unit's NVS partition, and the unit behaves exactly as in §2.

The owner then redeems the claim code in the console at the staging origin.

### The environment and the thread

Nothing to do on the device. The owner binds the environment and thread to the unit in the console;
the unit reads them from `GET /v1/device/config` and caches the response in `cfg_cache`.

### The release channel

Publish to staging the same way as to the bench gateway:

```
NEXT_CODER_URL=https://agent-controller-cloud-staging.sergio-williomes.workers.dev \
FACTORY_TOKEN=<the staging control plane's factory token> \
HARDWARE_MODEL=ips28-esp32-s3r8 \
FIRMWARE_VERSION=0.2.4 FIRMWARE_MANDATORY=1 \
FIRMWARE_FILE=<the built firmware.bin> \
node scripts/publish-firmware-release.mjs
```

A `mandatory` release is the one that exercises the unattended install path: the unit only writes
flash when the gateway answers `installation: "automatic"`, which happens for a mandatory release, a
queued `desiredVersion`, or an `automatic` update mode.

## 6. Where the staging path is blocked today

The staging edge is up and healthy (`GET /health` answers 200), but every `/v1/*` request it
forwards to its private control plane answers **503 `control_plane_unavailable`**. The chain is:

```
edge worker  ->  env.CONTROL_PLANE.fetch()  ->  control-plane worker
                                             ->  container.startAndWaitForPorts()
                                             ->  throws: Cloudflare Containers is not available on
                                                 this account (Workers Paid plan required)
```

The edge's `/health` cannot see this: it checks that the service binding exists and that the
background queues are configured, not that the control plane can start a container.

Two configuration gaps sit behind that blocker and have to be closed before a staging unit can be
registered at all:

- **`FACTORY_TOKEN` is not in the staging control plane's secret set.** Without it the factory
  routes answer 401 ("Missing or invalid factory token"), so no unit can be registered or claimed.
- **`OTA_SIGNING_KEY` is not in the staging control plane's secret set.** Without it
  `GET /v1/device/firmware` answers 503 ("OTA_SIGNING_KEY is required for firmware manifests"), so
  the unit's OTA poll cannot return a manifest at all.

Both are one-line additions to `REQUIRED_CONTROL_PLANE_SECRETS` in `scripts/staging-release.mjs`,
one `wrangler secret put` each, and one control-plane redeploy. They are worth doing regardless of
the plan: the same secret list has to carry them for production too.
