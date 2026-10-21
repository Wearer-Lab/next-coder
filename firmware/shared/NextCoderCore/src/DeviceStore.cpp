#include "DeviceStore.h"

#include <ArduinoJson.h>

#include "GatewayTls.h"

namespace {
// NVS keys are capped at 15 characters, which is why these are abbreviated rather than spelled out.
constexpr const char* kNamespace = "agentctl";
constexpr const char* kKeyDeviceId = "dev_id";
constexpr const char* kKeyDeviceSecret = "dev_secret";
constexpr const char* kKeyCredentialVersion = "cred_ver";
constexpr const char* kKeyPendingDeviceSecret = "cred_psec";
constexpr const char* kKeyPendingRotationId = "cred_rid";
constexpr const char* kKeyPendingCredentialVersion = "cred_pver";
constexpr const char* kKeyPendingCredentialPurpose = "cred_purp";
constexpr const char* kKeyGatewayUrl = "gw_url";
constexpr const char* kKeyGatewayProfiles = "gw_profiles";
constexpr const char* kKeyGatewayRevision = "gw_rev";
constexpr const char* kKeyGatewayActive = "gw_active";
constexpr const char* kKeyGatewayPending = "gw_pending";
constexpr const char* kKeyGatewayPendingUrl = "gw_purl";
constexpr const char* kKeyGatewayPrevious = "gw_prev";
constexpr const char* kKeyGatewayState = "gw_state";
constexpr const char* kKeyGatewayError = "gw_error";
constexpr const char* kKeyWifiSsid = "wifi_ssid";
constexpr const char* kKeyWifiPass = "wifi_pass";
constexpr const char* kKeyClaimCode = "claim_code";
constexpr const char* kKeyClaimExpiry = "claim_exp";
constexpr const char* kKeyConfigCache = "cfg_cache";
constexpr const char* kKeyPendingRequestId = "req_id";
constexpr const char* kKeyPendingRequestHash = "req_hash";
constexpr const char* kKeyOtaSource = "ota_from";
constexpr const char* kKeyOtaTarget = "ota_target";
constexpr const char* kKeyOtaBoots = "ota_boots";
constexpr const char* kKeyOtaBootTarget = "ota_bver";
}  // namespace

bool DeviceStore::begin() {
  if (opened_) return true;
  if (!prefs_.begin(kNamespace, /*readOnly=*/false)) {
    Serial.println("[store] NVS namespace unavailable; check the partition table");
    return false;
  }
  opened_ = true;

  deviceId_ = readString(kKeyDeviceId);
  deviceSecret_ = readString(kKeyDeviceSecret);
  credentialVersion_ = prefs_.getUInt(kKeyCredentialVersion, 1);
  pendingDeviceSecret_ = readString(kKeyPendingDeviceSecret);
  pendingCredentialRotationId_ = readString(kKeyPendingRotationId);
  pendingCredentialVersion_ = prefs_.getUInt(kKeyPendingCredentialVersion, 0);
  pendingCredentialPurpose_ = readString(kKeyPendingCredentialPurpose);
  if (pendingCredentialRotationId_.length() == 0 || pendingDeviceSecret_.length() == 0
      || pendingCredentialVersion_ <= credentialVersion_) {
    rollbackPendingDeviceSecret();
  }
  gatewayUrl_ = readString(kKeyGatewayUrl);
  gatewayRevision_ = prefs_.getUInt(kKeyGatewayRevision, 0);
  activeGatewayProfileId_ = readString(kKeyGatewayActive);
  pendingGatewayProfileId_ = readString(kKeyGatewayPending);
  pendingGatewayUrl_ = readString(kKeyGatewayPendingUrl);
  previousGatewayUrl_ = readString(kKeyGatewayPrevious);
  gatewaySwitchState_ = readString(kKeyGatewayState);
  if (gatewaySwitchState_.length() == 0) gatewaySwitchState_ = "stable";
  gatewaySwitchDetail_ = readString(kKeyGatewayError);

  // Old images accepted arbitrary schemes into NVS. Do not let a persisted plaintext/public URL
  // bypass the new socket boundary after an OTA: discard it before any gateway client can read it.
  auto discardInvalidGatewayUrl = [this](String& value, const char* key) {
    if (value.length() == 0 || gateway_tls::gatewayUrlAllowed(value)) return;
    Serial.printf("[store] discarded insecure or invalid gateway URL from %s\n", key);
    value = "";
    prefs_.remove(key);
  };
  discardInvalidGatewayUrl(gatewayUrl_, kKeyGatewayUrl);
  discardInvalidGatewayUrl(pendingGatewayUrl_, kKeyGatewayPendingUrl);
  discardInvalidGatewayUrl(previousGatewayUrl_, kKeyGatewayPrevious);

  const String profilesJson = readString(kKeyGatewayProfiles);
  if (profilesJson.length() > 0) {
    JsonDocument doc;
    if (deserializeJson(doc, profilesJson) == DeserializationError::Ok) {
      JsonArray profiles = doc.as<JsonArray>();
      for (JsonObject profile : profiles) {
        if (gatewayProfileCount_ >= kMaxGatewayProfiles) break;
        GatewayProfile& output = gatewayProfiles_[gatewayProfileCount_];
        output.id = String(profile["id"] | "");
        output.label = String(profile["label"] | "");
        output.mode = String(profile["mode"] | "custom");
        output.url = String(profile["url"] | "");
        if (output.id.length() == 0 || !gateway_tls::gatewayUrlAllowed(output.url)) continue;
        gatewayProfileCount_ += 1;
      }
    } else {
      Serial.println("[store] ignoring invalid persisted gateway profile JSON");
    }
  }
  wifiSsid_ = readString(kKeyWifiSsid);
  wifiPassword_ = readString(kKeyWifiPass);
  claimCode_ = readString(kKeyClaimCode);
  claimCodeExpiresAt_ = readString(kKeyClaimExpiry);
  configCache_ = readString(kKeyConfigCache);
  pendingRequestId_ = readString(kKeyPendingRequestId);
  pendingRequestHash_ = readString(kKeyPendingRequestHash);
  otaSourceVersion_ = readString(kKeyOtaSource);
  otaTargetVersion_ = readString(kKeyOtaTarget);

  // The secret is never logged, not even truncated: this line ends up in bench transcripts.
  Serial.printf(
    "[store] id=%s gateway=%s gatewayProfiles=%u gatewayState=%s wifi=%s claimCode=%s\n",
    deviceId_.length() ? deviceId_.c_str() : "(none)",
    gatewayUrl_.length() ? gatewayUrl_.c_str() : "(none)",
    static_cast<unsigned>(gatewayProfileCount_),
    gatewaySwitchState_.c_str(),
    wifiSsid_.length() ? wifiSsid_.c_str() : "(none)",
    claimCode_.length() ? "cached" : "(none)"
  );
  return true;
}

// Preferences::getString() logs an ESP_LOGE for every absent key. A factory-fresh unit is missing
// five of them by definition, so a perfectly healthy first boot printed five red error lines and
// read as a fault. Checking first keeps the log honest about what is actually wrong.
String DeviceStore::readString(const char* key) {
  if (!prefs_.isKey(key)) return String();
  return prefs_.getString(key, "");
}

bool DeviceStore::putString(const char* key, const String& value) {
  if (!opened_) return false;
  if (value.length() == 0) return prefs_.remove(key) || true;
  return prefs_.putString(key, value) > 0;
}

bool DeviceStore::setPendingRequest(const String& requestId, const String& requestHash) {
  if (requestId.length() == 0 || requestHash.length() == 0) return false;
  if (!putString(kKeyPendingRequestHash, requestHash)) return false;
  if (!putString(kKeyPendingRequestId, requestId)) return false;
  pendingRequestHash_ = requestHash;
  pendingRequestId_ = requestId;
  return true;
}

bool DeviceStore::clearPendingRequest() {
  const bool idCleared = putString(kKeyPendingRequestId, "");
  const bool hashCleared = putString(kKeyPendingRequestHash, "");
  if (idCleared) pendingRequestId_ = "";
  if (hashCleared) pendingRequestHash_ = "";
  return idCleared && hashCleared;
}

bool DeviceStore::setIdentity(const String& id, const String& secret) {
  if (!putString(kKeyDeviceId, id)) return false;
  if (!putString(kKeyDeviceSecret, secret)) return false;
  if (prefs_.putUInt(kKeyCredentialVersion, 1) == 0) return false;
  deviceId_ = id;
  deviceSecret_ = secret;
  credentialVersion_ = 1;
  rollbackPendingDeviceSecret();
  return true;
}

bool DeviceStore::stagePendingDeviceSecret(
  const String& secret,
  const String& rotationId,
  uint32_t credentialVersion,
  const String& purpose
) {
  if (!opened_ || secret.length() < 32 || rotationId.length() == 0
      || credentialVersion <= credentialVersion_
      || (purpose != "rotate" && purpose != "transfer")) return false;

  // Write the material first and the rotation id last. Its presence is the commit marker read by
  // begin(), so an interrupted write is rolled back instead of being sent or promoted.
  if (!putString(kKeyPendingDeviceSecret, secret)
      || prefs_.putUInt(kKeyPendingCredentialVersion, credentialVersion) == 0
      || !putString(kKeyPendingCredentialPurpose, purpose)
      || !putString(kKeyPendingRotationId, rotationId)) {
    rollbackPendingDeviceSecret();
    return false;
  }
  pendingDeviceSecret_ = secret;
  pendingCredentialVersion_ = credentialVersion;
  pendingCredentialPurpose_ = purpose;
  pendingCredentialRotationId_ = rotationId;
  return true;
}

bool DeviceStore::promotePendingDeviceSecret(const String& rotationId, uint32_t credentialVersion) {
  if (!hasPendingDeviceSecret() || rotationId != pendingCredentialRotationId_
      || credentialVersion != pendingCredentialVersion_) return false;

  // The active write comes first. If power fails before cleanup, both slots contain the promoted
  // secret and the next boot safely replays the idempotent ACK before clearing the pending slot.
  if (!putString(kKeyDeviceSecret, pendingDeviceSecret_)) return false;
  if (prefs_.putUInt(kKeyCredentialVersion, pendingCredentialVersion_) == 0) return false;
  deviceSecret_ = pendingDeviceSecret_;
  credentialVersion_ = pendingCredentialVersion_;
  return rollbackPendingDeviceSecret();
}

bool DeviceStore::rollbackPendingDeviceSecret() {
  if (!opened_) return false;
  const bool secretCleared = putString(kKeyPendingDeviceSecret, "");
  const bool idCleared = putString(kKeyPendingRotationId, "");
  const bool purposeCleared = putString(kKeyPendingCredentialPurpose, "");
  const bool versionCleared = prefs_.remove(kKeyPendingCredentialVersion) || true;
  if (secretCleared) pendingDeviceSecret_ = "";
  if (idCleared) pendingCredentialRotationId_ = "";
  if (purposeCleared) pendingCredentialPurpose_ = "";
  if (versionCleared) pendingCredentialVersion_ = 0;
  return secretCleared && idCleared && purposeCleared && versionCleared;
}

bool DeviceStore::seedIdentityIfEmpty(const char* id, const char* secret, const char* gatewayUrl) {
  bool wrote = false;
  // Placeholder values from controller_config.example.h are treated as absent; writing
  // "dev_replace_me" to NVS would look provisioned and fail authentication forever.
  const bool idUsable = id != nullptr && strlen(id) > 0 && strstr(id, "replace_me") == nullptr;
  const bool secretUsable =
    secret != nullptr && strlen(secret) > 0 && strstr(secret, "replace_me") == nullptr;

  if (!hasIdentity() && idUsable && secretUsable) {
    Serial.println("[store] seeding identity from build-time config (bench path)");
    wrote = setIdentity(String(id), String(secret)) || wrote;
  }
  if (gatewayUrl_.length() == 0 && gatewayUrl != nullptr && strlen(gatewayUrl) > 0) {
    wrote = setGatewayUrl(String(gatewayUrl)) || wrote;
  }
  return wrote;
}

bool DeviceStore::setGatewayUrl(const String& url) {
  String trimmed = url;
  trimmed.trim();
  while (trimmed.endsWith("/")) trimmed.remove(trimmed.length() - 1);
  if (trimmed.length() > 0 && !gateway_tls::gatewayUrlAllowed(trimmed)) {
    Serial.println("[store] refused insecure or invalid gateway URL");
    return false;
  }
  if (gatewayUrl_ == trimmed) return true;
  if (!putString(kKeyGatewayUrl, trimmed)) return false;
  gatewayUrl_ = trimmed;
  return true;
}

const GatewayProfile* DeviceStore::gatewayProfile(size_t index) const {
  return index < gatewayProfileCount_ ? &gatewayProfiles_[index] : nullptr;
}

const GatewayProfile* DeviceStore::findGatewayProfile(const String& id) const {
  for (size_t index = 0; index < gatewayProfileCount_; index += 1) {
    if (gatewayProfiles_[index].id == id) return &gatewayProfiles_[index];
  }
  return nullptr;
}

bool DeviceStore::replaceGatewayProfiles(
  const GatewayProfile* profiles,
  size_t count,
  uint32_t revision,
  const String& activeProfileId
) {
  if (!opened_ || profiles == nullptr || count == 0 || count > kMaxGatewayProfiles) return false;
  for (size_t index = 0; index < count; index += 1) {
    if (profiles[index].id.length() == 0 || !gateway_tls::gatewayUrlAllowed(profiles[index].url)) {
      Serial.println("[store] refused gateway profile with insecure or invalid URL");
      return false;
    }
  }

  JsonDocument doc;
  JsonArray output = doc.to<JsonArray>();
  for (size_t index = 0; index < count; index += 1) {
    JsonObject profile = output.add<JsonObject>();
    profile["id"] = profiles[index].id;
    profile["label"] = profiles[index].label;
    profile["mode"] = profiles[index].mode;
    profile["url"] = profiles[index].url;
  }
  String encoded;
  serializeJson(doc, encoded);
  if (!putString(kKeyGatewayProfiles, encoded)) return false;
  if (prefs_.putUInt(kKeyGatewayRevision, revision) == 0) return false;

  gatewayProfileCount_ = count;
  for (size_t index = 0; index < count; index += 1) gatewayProfiles_[index] = profiles[index];
  gatewayRevision_ = revision;

  // A pending local selection is the controller's recovery journal. A routine GET must not erase
  // it merely because the server has not observed the ACK yet.
  if (pendingGatewayProfileId_.length() == 0 && activeProfileId.length() > 0) {
    if (!putString(kKeyGatewayActive, activeProfileId)) return false;
    activeGatewayProfileId_ = activeProfileId;
  }
  return true;
}

bool DeviceStore::stageGatewaySwitch(const GatewayProfile& profile, uint32_t revision) {
  if (!opened_ || profile.id.length() == 0 || !gateway_tls::gatewayUrlAllowed(profile.url)) return false;
  const String previous = gatewayUrl_;
  if (!putString(kKeyGatewayPrevious, previous)) return false;
  if (!putString(kKeyGatewayPending, profile.id)) return false;
  if (!putString(kKeyGatewayPendingUrl, profile.url)) return false;
  if (!putString(kKeyGatewayState, "pending")) return false;
  if (!putString(kKeyGatewayError, "")) return false;
  if (prefs_.putUInt(kKeyGatewayRevision, revision) == 0) return false;
  previousGatewayUrl_ = previous;
  pendingGatewayProfileId_ = profile.id;
  pendingGatewayUrl_ = profile.url;
  gatewaySwitchState_ = "pending";
  gatewaySwitchDetail_ = "";
  gatewayRevision_ = revision;
  return true;
}

bool DeviceStore::completeGatewaySwitch(const GatewayProfile& profile, uint32_t revision) {
  // gw_url is deliberately written last in the happy-path journal. Until this succeeds, a reboot
  // continues to use the previous known-good endpoint and resumes the pending selection.
  if (!putString(kKeyGatewayActive, profile.id)) return false;
  if (!setGatewayUrl(profile.url)) return false;
  if (!putString(kKeyGatewayPending, "")) return false;
  if (!putString(kKeyGatewayPendingUrl, "")) return false;
  if (!putString(kKeyGatewayPrevious, "")) return false;
  if (!putString(kKeyGatewayState, "stable")) return false;
  if (!putString(kKeyGatewayError, "")) return false;
  if (prefs_.putUInt(kKeyGatewayRevision, revision) == 0) return false;
  activeGatewayProfileId_ = profile.id;
  pendingGatewayProfileId_ = "";
  pendingGatewayUrl_ = "";
  previousGatewayUrl_ = "";
  gatewaySwitchState_ = "stable";
  gatewaySwitchDetail_ = "";
  gatewayRevision_ = revision;
  return true;
}

bool DeviceStore::failGatewaySwitch(const String& detail, uint32_t revision) {
  // completeGatewaySwitch writes the active URL only after the remote apply ACK, but restore the
  // journaled URL defensively so this also recovers images that rebooted between older steps.
  if (previousGatewayUrl_.length() > 0 && gatewayUrl_ != previousGatewayUrl_) {
    if (!setGatewayUrl(previousGatewayUrl_)) return false;
  }
  if (!putString(kKeyGatewayPending, "")) return false;
  if (!putString(kKeyGatewayPendingUrl, "")) return false;
  if (!putString(kKeyGatewayPrevious, "")) return false;
  if (!putString(kKeyGatewayState, "failed")) return false;
  if (!putString(kKeyGatewayError, detail)) return false;
  if (prefs_.putUInt(kKeyGatewayRevision, revision) == 0) return false;
  pendingGatewayProfileId_ = "";
  pendingGatewayUrl_ = "";
  previousGatewayUrl_ = "";
  gatewaySwitchState_ = "failed";
  gatewaySwitchDetail_ = detail;
  gatewayRevision_ = revision;
  return true;
}

bool DeviceStore::clearGatewaySwitchFailure() {
  if (gatewaySwitchState_ != "failed") return true;
  if (!putString(kKeyGatewayState, "stable")) return false;
  if (!putString(kKeyGatewayError, "")) return false;
  gatewaySwitchState_ = "stable";
  gatewaySwitchDetail_ = "";
  return true;
}

bool DeviceStore::ensureLegacyGatewayProfile() {
  if (gatewayProfileCount_ > 0 || gatewayUrl_.length() == 0) return true;
  GatewayProfile legacy;
  legacy.id = "legacy";
  legacy.label = "Current gateway";
  legacy.mode = "custom";
  legacy.url = gatewayUrl_;
  return replaceGatewayProfiles(&legacy, 1, gatewayRevision_, "legacy");
}

bool DeviceStore::setWifiCredentials(const String& ssid, const String& password) {
  if (!putString(kKeyWifiSsid, ssid)) return false;
  if (!putString(kKeyWifiPass, password)) return false;
  wifiSsid_ = ssid;
  wifiPassword_ = password;
  return true;
}

bool DeviceStore::setClaimCode(const String& code, const String& expiresAt) {
  // Same reason as setConfigCache(): an unclaimed device is told its code on every poll, and
  // rewriting an unchanged code burns flash for no gain.
  if (claimCode_ == code && claimCodeExpiresAt_ == expiresAt) return true;
  if (!putString(kKeyClaimCode, code)) return false;
  if (!putString(kKeyClaimExpiry, expiresAt)) return false;
  claimCode_ = code;
  claimCodeExpiresAt_ = expiresAt;
  return true;
}

bool DeviceStore::clearClaimCode() {
  return setClaimCode("", "");
}

bool DeviceStore::setConfigCache(const String& json) {
  // fetchConfig() calls this on every successful poll, and the payload is usually byte-identical to
  // the one already stored. Without this guard that is a full NVS write of the whole config blob
  // every config interval: flash wear for nothing, and — because an NVS write disables the CPU
  // cache while the flash operation runs — a repeated window where WiFi buffers living in PSRAM
  // cannot be read. Comparing first turns the steady state into no flash traffic at all.
  if (configCache_ == json) return true;
  if (!putString(kKeyConfigCache, json)) return false;
  configCache_ = json;
  return true;
}

bool DeviceStore::setOtaAttempt(const String& sourceVersion, const String& targetVersion) {
  if (!putString(kKeyOtaSource, sourceVersion)) return false;
  if (!putString(kKeyOtaTarget, targetVersion)) return false;
  otaSourceVersion_ = sourceVersion;
  otaTargetVersion_ = targetVersion;
  return prefs_.putUInt(kKeyOtaBoots, 0) > 0;
}

uint32_t DeviceStore::registerOtaBootAttempt(const String& runningVersion) {
  if (!opened_ || otaTargetVersion_.length() == 0 || otaTargetVersion_ != runningVersion) return 0;
  // The source image may predate the boot counter and therefore cannot reset it
  // in setOtaAttempt(). Key the count to the running target so an upgrade from
  // old firmware never inherits a previous release's failed-attempt count.
  const String countedTarget = readString(kKeyOtaBootTarget);
  const uint32_t attempts = countedTarget == runningVersion
    ? prefs_.getUInt(kKeyOtaBoots, 0) + 1
    : 1;
  if (!putString(kKeyOtaBootTarget, runningVersion)) return 0;
  return prefs_.putUInt(kKeyOtaBoots, attempts) > 0 ? attempts : 0;
}

bool DeviceStore::clearOtaAttempt() {
  const bool sourceCleared = putString(kKeyOtaSource, "");
  const bool targetCleared = putString(kKeyOtaTarget, "");
  const bool bootsCleared = prefs_.remove(kKeyOtaBoots) || !prefs_.isKey(kKeyOtaBoots);
  const bool bootTargetCleared = putString(kKeyOtaBootTarget, "");
  if (sourceCleared) otaSourceVersion_ = "";
  if (targetCleared) otaTargetVersion_ = "";
  return sourceCleared && targetCleared && bootsCleared && bootTargetCleared;
}

bool DeviceStore::resetForProvisioning() {
  Serial.println("[store] reset: clearing Wi-Fi, config cache, and claim code; identity kept");
  const bool wifiCleared = setWifiCredentials("", "");
  const bool cacheCleared = setConfigCache("");
  const bool codeCleared = clearClaimCode();
  const bool requestCleared = clearPendingRequest();
  return wifiCleared && cacheCleared && codeCleared && requestCleared;
}

bool DeviceStore::wipeToFactoryState() {
  Serial.println("[store] full wipe: Wi-Fi, config cache, claim code, gateway URL; identity kept");
  const bool reset = resetForProvisioning();
  // Cleared rather than rewritten: seedIdentityIfEmpty() puts the build-time default back on the
  // next boot, so a unit whose owner pointed it at a private gateway returns to the factory one.
  const bool gatewayCleared = setGatewayUrl("");
  const bool profilesCleared = putString(kKeyGatewayProfiles, "");
  const bool activeCleared = putString(kKeyGatewayActive, "");
  const bool pendingCleared = putString(kKeyGatewayPending, "")
    && putString(kKeyGatewayPendingUrl, "") && putString(kKeyGatewayPrevious, "");
  const bool stateCleared = putString(kKeyGatewayState, "") && putString(kKeyGatewayError, "");
  const bool revisionCleared = prefs_.remove(kKeyGatewayRevision) || !prefs_.isKey(kKeyGatewayRevision);
  if (profilesCleared) gatewayProfileCount_ = 0;
  if (activeCleared) activeGatewayProfileId_ = "";
  if (pendingCleared) {
    pendingGatewayProfileId_ = "";
    pendingGatewayUrl_ = "";
    previousGatewayUrl_ = "";
  }
  if (stateCleared) {
    gatewaySwitchState_ = "stable";
    gatewaySwitchDetail_ = "";
  }
  if (revisionCleared) gatewayRevision_ = 0;
  return reset && gatewayCleared && profilesCleared && activeCleared && pendingCleared
    && stateCleared && revisionCleared;
}
