#pragma once

// Wi-Fi provisioning: the boot state machine plus its first transport, a SoftAP captive portal.
//
// The rule the whole design serves: the device never blocks indefinitely in any state. Every state
// has a screen, and every failure has a next action visible on that screen. The old firmware looped
// forever inside connectWiFi(), so a mistyped password bricked the unit until someone reflashed it
// over USB.
//
// BLE is the intended second transport (deferred until there is a companion app). It plugs in as
// another ProvisioningTransport rather than a rewrite, which is why the seam exists now.

#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include "DeviceStore.h"

enum class ProvisioningState {
  Unprovisioned,  // identity present, no Wi-Fi credentials
  Provisioning,   // SoftAP portal is up, waiting for credentials
  Connecting,     // joining the stored network
  Online,         // joined; the gateway conversation decides claimed vs unclaimed vs revoked
  Failed,         // repeated join failures; falls back to Provisioning
};

const char* provisioningStateName(ProvisioningState state);

struct ProvisioningStatus {
  ProvisioningState state = ProvisioningState::Unprovisioned;
  String apName;         // populated while the portal is up
  String portalUrl;      // "http://192.168.4.1"
  String detail;         // short, screen-ready reason for the current state
  uint8_t joinFailures = 0;
};

class Provisioning {
 public:
  // `apNameSeed` is the device id; the AP takes its last four characters so two units on a bench
  // are distinguishable. The portal is an open network on purpose — it never carries the device
  // secret, and a WPA passphrase read off a 122x250 panel doubles the failure surface for no gain.
  void begin(DeviceStore& store, const String& apNameSeed);

  // Drives the state machine. Non-blocking: call it from loop(). Returns the current state so the
  // caller can render without a second call.
  ProvisioningState poll();

  const ProvisioningStatus& status() const { return status_; }
  bool online() const { return status_.state == ProvisioningState::Online; }

  // Called by the long-press reset. Wipes credentials and re-raises the portal.
  void resetToProvisioning();

  // Re-raises the portal WITHOUT wiping anything, so the owner can correct a setting and rejoin.
  //
  // This exists because the gateway URL is entered once, during first setup, and the portal closes
  // the moment Wi-Fi joins. A typo in that URL therefore left the device online, unable to reach
  // any gateway, and with no way back into the form — the only escape was the long-press wipe,
  // which also destroys working Wi-Fi credentials the owner had no reason to lose.
  void openConfigPortal();

  // True while the portal was opened for reconfiguration rather than first-time setup, which is
  // when the station stays up and LAN discovery can work.
  bool configPortalActive() const { return configPortal_; }

  // Leaves the config portal without changing anything, returning the device to normal operation.
  // Only meaningful while configPortalActive(): during first-time setup there is nowhere to go.
  void closeConfigPortal();

  // True exactly once after a successful join, so the caller can re-run its gateway handshake.
  bool consumeJustConnected();

 private:
  void enterProvisioning(bool keepStation = false);
  void enterConnecting();
  void startPortal(bool keepStation = false);
  void stopPortal();
  void handlePortalRoot();
  void handlePortalSubmit();
  void handlePortalNotFound();
  bool attemptJoin(const String& ssid, const String& password, uint32_t timeoutMs);
  String scanOptionsHtml();

  DeviceStore* store_ = nullptr;
  bool configPortal_ = false;
  String discovered_;   // result of the last portal search, prefilled into the form
  ProvisioningStatus status_;
  String apName_;
  DNSServer dns_;
  WebServer server_{80};
  bool portalUp_ = false;
  bool routesRegistered_ = false;
  bool justConnected_ = false;
  uint32_t connectStartedAt_ = 0;
  uint32_t portalLastClientAt_ = 0;
  String portalError_;
  String scanCache_;
  uint32_t scanCachedAt_ = 0;
};
