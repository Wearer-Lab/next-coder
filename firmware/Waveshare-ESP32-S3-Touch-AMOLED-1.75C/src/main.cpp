// Waveshare ESP32-S3-Touch-AMOLED-1.75C — safe network bring-up target.
//
// The board and every peripheral pin remain unverified. This target therefore touches no AMOLED,
// touch, PMIC, or audio pin. It does exercise the board-independent product path that is safe to
// prove without them: NVS identity, owner Wi-Fi provisioning, authenticated cloud heartbeat,
// stable claim code, credential rotation, OTA rollback observation, and explicit recovery.
//
// USB serial reports link transitions for bring-up evidence, but exposes no remote-operation
// command surface. The heartbeat explicitly advertises no display, thread picker, microphone, or
// camera until the corresponding hardware path has been verified on a 1.75C.

#include <Arduino.h>
#include <WiFi.h>

#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "amoled175-esp32-s3r8"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

namespace {

DeviceStore store;
Provisioning provisioning;
GatewayClient gateway;

ProvisioningState lastState = ProvisioningState::Unprovisioned;
uint32_t bootHeldSince = 0;
bool bootWasDown = false;
bool bootResetFired = false;
GatewayLink observedGatewayLink = GatewayLink::Idle;
uint32_t observedGatewayRevision = 0;

// PSRAM is not optional once the display or microphone is enabled: one 16-bpp framebuffer is
// ~434 KB and a 30 s mono clip is ~960 KB. Report it now without treating its absence as proof of
// any peripheral failure.
void reportMemory() {
  Serial.printf("Flash size:  %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("Heap free:   %u bytes\n", (unsigned)ESP.getFreeHeap());

  const size_t psram = ESP.getPsramSize();
  if (psram == 0) {
    Serial.println("PSRAM:       NOT DETECTED");
    Serial.println("  Display/audio remain disabled. Check qio_opi before peripheral bring-up.");
    return;
  }
  Serial.printf("PSRAM:       %u bytes free of %u\n",
                (unsigned)ESP.getFreePsram(), (unsigned)psram);
}

void reportIdentity() {
  if (store.hasIdentity()) {
    Serial.printf("Device id:   %s\n", store.deviceId().c_str());
    Serial.printf("Gateway:     %s\n", store.gatewayUrl().c_str());
    return;
  }
  Serial.println("Device id:   none in NVS");
  Serial.println("  Factory identity is required; an owner cannot repair this over the portal.");
}

void reportState(ProvisioningState state) {
  const ProvisioningStatus& status = provisioning.status();
  Serial.printf("[provisioning] %s", provisioningStateName(state));
  if (status.detail.length()) Serial.printf(" — %s", status.detail.c_str());
  Serial.println();

  if (state == ProvisioningState::Provisioning) {
    Serial.printf("  Join \"%s\" and open %s to set Wi-Fi/gateway.\n",
                  status.apName.c_str(), status.portalUrl.c_str());
  }
  if (state == ProvisioningState::Online) {
    Serial.printf("  IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
}

void reportGatewayChanges() {
  if (!gateway.tryLockState(0)) return;
  const GatewayLink link = gateway.link();
  const uint32_t revision = gateway.revision();
  if (link == observedGatewayLink && revision == observedGatewayRevision) {
    gateway.unlockState();
    return;
  }
  observedGatewayLink = link;
  observedGatewayRevision = revision;

  Serial.printf("[gateway] %s", gatewayLinkName(link));
  if (gateway.detail().length()) Serial.printf(" — %s", gateway.detail().c_str());
  Serial.println();
  if (link == GatewayLink::Unclaimed) {
    if (gateway.claimCode().length()) {
      Serial.printf("  claim code: %s", gateway.claimCode().c_str());
      if (store.claimCodeExpiresAt().length()) {
        Serial.printf(" (expires %s)", store.claimCodeExpiresAt().c_str());
      }
      Serial.println();
    } else {
      Serial.println("  claim code pending; keep the gateway reachable");
    }
  } else if (link == GatewayLink::Revoked) {
    Serial.println("  ACCESS REMOVED — hold BOOT 10 s to clear owner setup and re-provision");
  } else if (link == GatewayLink::NoIdentity) {
    Serial.println("  factory identity missing; owner provisioning cannot repair it");
  } else if (link == GatewayLink::Claimed) {
    Serial.println("  claimed and healthy; hardware operation remains disabled in this scaffold");
  }
  gateway.unlockState();
}

// BOOT uses the same recoverable contract as the proven touchscreen controller: a tap reopens the
// configuration portal without destroying working Wi-Fi, while a 10 s hold clears Wi-Fi/config
// cache/claim-code but preserves the factory identity. A stolen unit cannot unbind itself.
void pollBootButton() {
  const bool down = digitalRead(BOOT_BUTTON_PIN) == LOW;

  if (down && !bootWasDown) {
    bootHeldSince = millis();
    bootWasDown = true;
    bootResetFired = false;
    return;
  }

  if (down) {
    if (!bootResetFired && millis() - bootHeldSince >= PROVISIONING_RESET_HOLD_MS) {
      bootResetFired = true;
      Serial.println("[provisioning] BOOT held — clearing owner setup and reopening provisioning.");
      provisioning.resetToProvisioning();
    }
    return;
  }

  if (!bootWasDown) return;
  bootWasDown = false;
  if (bootResetFired) return;

  Serial.println("[provisioning] BOOT tapped — opening the configuration portal.");
  provisioning.openConfigPortal();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // diagnostics must never stop the controller when no host is reading
  delay(2000);               // native USB CDC enumeration; bounded and boot-only

  Serial.println();
  Serial.println("=== Next Coder — Waveshare AMOLED 1.75C safe bring-up ===");
  Serial.printf("Model:       %s\n", HARDWARE_MODEL);
  Serial.printf("Firmware:    %s\n", FIRMWARE_VERSION);
  Serial.println("Capabilities: none (AMOLED/touch/audio remain unverified and disabled)");
  reportMemory();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  if (!store.begin()) {
    Serial.println("FATAL: NVS unavailable. Check board_build.partitions in platformio.ini.");
    return;
  }

  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  reportIdentity();

  // The four-argument form is intentional. This build has authenticated cloud transport and a
  // USB serial diagnostics, but neither is evidence that the customer can see or operate the
  // round screen. The gateway must not assign any hardware control on that basis.
  gateway.setCapabilities(false, false, false, false);
  GatewayLimits limits;
  limits.menuItems = 0;
  limits.threadItems = 0;
  limits.labelCharacters = 0;
  limits.mediaUploadBytes = 0;
  gateway.setLimits(limits);
  gateway.begin(store, HARDWARE_MODEL, FIRMWARE_VERSION);
  gateway.handleOtaBootAttempt();
  gateway.startNetworkTask();

  provisioning.begin(store, store.deviceId());
  lastState = provisioning.status().state;
  reportState(lastState);
}

void loop() {
  const ProvisioningState state = provisioning.poll();
  if (state != lastState) {
    lastState = state;
    reportState(state);
    if (state != ProvisioningState::Online && !provisioning.configPortalActive()) {
      if (gateway.tryLockState(0)) {
        gateway.goOffline();
        gateway.unlockState();
      }
    }
  }

  if (provisioning.consumeJustConnected()) {
    Serial.println("[provisioning] joined — starting authenticated gateway handshake.");
    gateway.notifyJustConnected();
  }

  pollBootButton();
  reportGatewayChanges();
  delay(10);
}
