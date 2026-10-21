#pragma once

// Writable device state, in NVS.
//
// Everything here used to be a compile-time `#define`, which is what made a shipped unit
// unrecoverable: the factory cannot know the customer's Wi-Fi network, a rotated secret could never
// reach the device, and a wrong password meant a USB reflash. Values that genuinely are fixed at
// build time — the pin map, hardware model, firmware version, OTA verify key — stay as macros.
//
// NVS namespace `agentctl`. On production units this partition should be covered by flash
// encryption: without it `esptool read_flash` recovers both the Wi-Fi password and the device
// secret. See docs/production-security.md.

#include <Arduino.h>
#include <Preferences.h>

constexpr size_t kMaxGatewayProfiles = 5;

struct GatewayProfile {
  String id;
  String label;
  String mode;
  String url;
};

class DeviceStore {
 public:
  // Opens the namespace and caches every value in RAM. Returns false if NVS is unavailable, which
  // on this hardware means the partition table is wrong — callers should treat it as fatal.
  bool begin();

  // --- Identity. Written once by the factory flashing station, never by the owner. ---
  const String& deviceId() const { return deviceId_; }
  const String& deviceSecret() const { return deviceSecret_; }
  uint32_t credentialVersion() const { return credentialVersion_; }
  bool hasIdentity() const { return deviceId_.length() > 0 && deviceSecret_.length() > 0; }
  bool setIdentity(const String& id, const String& secret);

  // A replacement credential is written to separate NVS keys before it is sent to the gateway.
  // The rotation id is the commit marker and is written last, so a power loss cannot make a
  // partially written candidate look usable. The active secret remains untouched until the
  // gateway has authenticated the candidate and acknowledged promotion.
  bool hasPendingDeviceSecret() const {
    return pendingDeviceSecret_.length() > 0 && pendingCredentialRotationId_.length() > 0
      && pendingCredentialVersion_ > credentialVersion_;
  }
  const String& pendingDeviceSecret() const { return pendingDeviceSecret_; }
  const String& pendingCredentialRotationId() const { return pendingCredentialRotationId_; }
  const String& pendingCredentialPurpose() const { return pendingCredentialPurpose_; }
  uint32_t pendingCredentialVersion() const { return pendingCredentialVersion_; }
  bool stagePendingDeviceSecret(
    const String& secret,
    const String& rotationId,
    uint32_t credentialVersion,
    const String& purpose
  );
  bool promotePendingDeviceSecret(const String& rotationId, uint32_t credentialVersion);
  bool rollbackPendingDeviceSecret();

  // Seeds identity and gateway URL from compile-time values only when NVS holds none. This is the
  // bench path — it lets a developer flash controller_config.h values without an NVS partition —
  // and deliberately never overwrites a provisioned unit.
  bool seedIdentityIfEmpty(const char* id, const char* secret, const char* gatewayUrl);

  // --- Gateway. Factory default, changeable at runtime by the owner via the portal. ---
  const String& gatewayUrl() const { return gatewayUrl_; }
  bool setGatewayUrl(const String& url);

  // Gateway profiles are synced from the authenticated gateway, but remain available when that
  // gateway is offline. `gw_url` remains the active URL for compatibility with every image already
  // in the field; profiles and switch metadata are additional keys, never a migration of it.
  size_t gatewayProfileCount() const { return gatewayProfileCount_; }
  const GatewayProfile* gatewayProfile(size_t index) const;
  const GatewayProfile* findGatewayProfile(const String& id) const;
  uint32_t gatewayRevision() const { return gatewayRevision_; }
  const String& activeGatewayProfileId() const { return activeGatewayProfileId_; }
  const String& pendingGatewayProfileId() const { return pendingGatewayProfileId_; }
  const String& pendingGatewayUrl() const { return pendingGatewayUrl_; }
  const String& previousGatewayUrl() const { return previousGatewayUrl_; }
  const String& gatewaySwitchState() const { return gatewaySwitchState_; }
  const String& gatewaySwitchDetail() const { return gatewaySwitchDetail_; }

  bool replaceGatewayProfiles(
    const GatewayProfile* profiles,
    size_t count,
    uint32_t revision,
    const String& activeProfileId
  );
  bool stageGatewaySwitch(const GatewayProfile& profile, uint32_t revision);
  bool completeGatewaySwitch(const GatewayProfile& profile, uint32_t revision);
  bool failGatewaySwitch(const String& detail, uint32_t revision);
  bool clearGatewaySwitchFailure();
  bool ensureLegacyGatewayProfile();

  // --- Wi-Fi. Written by the owner during provisioning. ---
  const String& wifiSsid() const { return wifiSsid_; }
  const String& wifiPassword() const { return wifiPassword_; }
  bool hasWifiCredentials() const { return wifiSsid_.length() > 0; }
  bool setWifiCredentials(const String& ssid, const String& password);

  // --- Claim code cache. ---
  //
  // The gateway stores claim codes hashed, so it can hand back the plaintext exactly once, at
  // issue. The device caching it here is what lets `POST /v1/device/setup-code` stop rotating on
  // every call — and therefore what makes the code printed on the box agree with the code on screen.
  const String& claimCode() const { return claimCode_; }
  const String& claimCodeExpiresAt() const { return claimCodeExpiresAt_; }
  bool hasClaimCode() const { return claimCode_.length() > 0; }
  bool setClaimCode(const String& code, const String& expiresAt);
  bool clearClaimCode();

  // --- Runtime config cache, so a boot with no gateway still renders something useful. ---
  const String& configCache() const { return configCache_; }
  bool setConfigCache(const String& json);

  // One uncertain agent write survives reboot. The body is represented only by a local
  // fingerprint; prompt/audio text is never copied into NVS. A positive HTTP response clears it.
  const String& pendingRequestId() const { return pendingRequestId_; }
  const String& pendingRequestHash() const { return pendingRequestHash_; }
  bool setPendingRequest(const String& requestId, const String& requestHash);
  bool clearPendingRequest();

  // --- OTA attempt marker. ---
  // Written only after a new image has been completely verified and committed to the inactive
  // partition. It survives the restart, which lets the previous image report a real bootloader
  // rollback instead of making that event indistinguishable from an ordinary boot.
  const String& otaSourceVersion() const { return otaSourceVersion_; }
  const String& otaTargetVersion() const { return otaTargetVersion_; }
  bool setOtaAttempt(const String& sourceVersion, const String& targetVersion);
  uint32_t registerOtaBootAttempt(const String& runningVersion);
  bool clearOtaAttempt();

  // Wipes Wi-Fi credentials, the config cache, and the cached claim code, and keeps the device
  // identity. This is the long-press reset: the recovery path for a revoked device, a moved
  // household, or a resale. Identity survives because the unit is still the same unit; the gateway
  // side of a transfer is `resetDeviceForTransfer`.
  bool resetForProvisioning();

  // Everything resetForProvisioning() clears, plus any owner-set gateway URL, returning the unit to
  // the state it left the factory in. seedIdentityIfEmpty() restores the build-time gateway default
  // on the next boot, so clearing it here is recoverable rather than a dead end.
  //
  // Identity is deliberately NOT cleared. The device id and secret are written once at manufacture;
  // erasing them leaves a unit that cannot authenticate and cannot be recovered without a flashing
  // station, which is a brick in the owner's hands. Detaching a device from an account is the
  // owner's action (`resetDeviceForTransfer`), not the hardware's — otherwise anyone holding a
  // stolen controller could unbind it from its owner.
  bool wipeToFactoryState();

 private:
  String readString(const char* key);
  bool putString(const char* key, const String& value);

  Preferences prefs_;
  bool opened_ = false;
  String deviceId_;
  String deviceSecret_;
  uint32_t credentialVersion_ = 1;
  String pendingDeviceSecret_;
  String pendingCredentialRotationId_;
  String pendingCredentialPurpose_;
  uint32_t pendingCredentialVersion_ = 0;
  String gatewayUrl_;
  GatewayProfile gatewayProfiles_[kMaxGatewayProfiles];
  size_t gatewayProfileCount_ = 0;
  uint32_t gatewayRevision_ = 0;
  String activeGatewayProfileId_;
  String pendingGatewayProfileId_;
  String pendingGatewayUrl_;
  String previousGatewayUrl_;
  String gatewaySwitchState_ = "stable";
  String gatewaySwitchDetail_;
  String wifiSsid_;
  String wifiPassword_;
  String claimCode_;
  String claimCodeExpiresAt_;
  String configCache_;
  String pendingRequestId_;
  String pendingRequestHash_;
  String otaSourceVersion_;
  String otaTargetVersion_;
};
