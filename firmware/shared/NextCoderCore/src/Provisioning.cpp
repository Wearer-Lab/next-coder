#include "Provisioning.h"

#include "GatewayDiscovery.h"
#include "GatewayTls.h"
#include <esp_wifi.h>
#include <esp_random.h>
#include <ArduinoJson.h>

namespace {
constexpr uint32_t kJoinTimeoutMs = 20000;
// After this many consecutive failures the stored network is presumed wrong and the portal comes
// back up. Three is enough to ride out a router still booting without stranding the owner.
constexpr uint8_t kMaxJoinFailures = 3;
// A unit left powered in a drawer must not sit as an open AP forever: the portal stands down, the
// last known network is retried, and the portal re-raises only if that fails again.
constexpr uint32_t kPortalIdleTimeoutMs = 15UL * 60UL * 1000UL;
constexpr uint32_t kScanCacheMs = 20000;
constexpr uint32_t kScanTimeoutMs = 15000;
constexpr uint32_t kSavedNetworkBackoffMs = 30000;
constexpr uint8_t kDnsPort = 53;

String htmlEscape(const String& value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i += 1) {
    const char c = value[i];
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else if (c == '\'') out += "&#39;";
    else out += c;
  }
  return out;
}
}  // namespace

const char* provisioningStateName(ProvisioningState state) {
  switch (state) {
    case ProvisioningState::Unprovisioned: return "unprovisioned";
    case ProvisioningState::Provisioning: return "provisioning";
    case ProvisioningState::Connecting: return "connecting";
    case ProvisioningState::Online: return "online";
    case ProvisioningState::Failed: return "failed";
  }
  return "unknown";
}

void Provisioning::begin(DeviceStore& store, const String& apNameSeed) {
  store_ = &store;
  WiFi.persistent(false); // candidate credentials stay in RAM until DeviceStore validates them
  WiFi.setAutoReconnect(false); // this bounded scheduler owns retries and candidate cancellation

  String suffix = apNameSeed;
  if (suffix.length() > 4) suffix = suffix.substring(suffix.length() - 4);
  suffix.toLowerCase();
  // An unprovisioned unit has no device id, so every one of them would advertise the same
  // "agent-ctl-0000". Fall back to the MAC, which is unique and available before any identity is.
  if (suffix.length() == 0) {
    const uint64_t mac = ESP.getEfuseMac();
    char macSuffix[5];
    snprintf(macSuffix, sizeof(macSuffix), "%04x", (unsigned)(mac & 0xFFFF));
    suffix = macSuffix;
  }
  apName_ = "agent-ctl-" + suffix;
  status_.apName = apName_;
  status_.portalUrl = "http://192.168.4.1";

  if (store_->hasWifiCredentials()) enterConnecting();
  else enterProvisioning();
}

void Provisioning::enterProvisioning(bool keepStation) {
  if (portalJoinPending_) {
    wifi_.candidateResult = WifiCandidateResult::Cancelled;
    wifi_.candidateDetail = "Join cancelled; saved networks kept";
  }
  cancelWifiScan();
  savedJoinPending_ = false;
  savedBeginPending_ = false;
  savedAttemptPassword_ = "";
  nextSavedAttemptAt_ = millis() + kSavedNetworkBackoffMs;
  portalJoinPending_ = false;
  candidateBeginPending_ = false;
  portalRecoveryPending_ = false;
  pendingPassword_ = "";
  pendingSsid_ = "";
  pendingGateway_ = "";
  status_.state = ProvisioningState::Provisioning;
  const String setupName = phone_.active ? phone_.apName : apName_;
  status_.detail = keepStation ? "Reconfigure at " + setupName : "Join " + setupName;

  // Reconfiguration keeps the station associated. That is what lets "Find gateway" in the portal
  // actually search: a device in pure SoftAP mode is not on the network it is being asked to
  // search, so the button could only ever time out.
  if (!keepStation && WiFi.getMode() != WIFI_OFF) {
    // Only tear down a station that exists. On a first boot with no stored credentials the Wi-Fi
    // driver has never been started, and disconnect() logs ESP_ERR_WIFI_NOT_INIT at error level --
    // alarming, and the very first thing an owner sees on the serial console of a new unit.
    WiFi.disconnect(true, false, 0);
  }
  startPortal(keepStation);
  publishWifi(keepStation && WiFi.status() == WL_CONNECTED ? WifiConnectionPhase::Connected : WifiConnectionPhase::Idle,
    keepStation ? "Network setup open; current network kept" : "Choose a network on device or setup page");
}

void Provisioning::publishWifi(WifiConnectionPhase phase, const String& detail) {
  wifi_.phase = phase;
  wifi_.detail = detail;
  wifi_.activeSsid = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : String();
  wifi_.targetSsid = portalJoinPending_ ? pendingSsid_ : savedJoinPending_ ? savedAttemptSsid_ : String();
  wifi_.joinPending = portalJoinPending_ || savedJoinPending_;
  wifi_.savedCount = store_ ? store_->savedWifiNamesSnapshot().size() : 0;
  ++wifi_.revision;
}

bool Provisioning::startWifiScan() {
  if (scan_.scanning || portalJoinPending_) return false;
  if (savedJoinPending_) {
    WiFi.disconnect(false, false, 0);
    savedJoinPending_ = false;
    savedBeginPending_ = false;
    savedAttemptPassword_ = "";
    nextSavedAttemptAt_ = millis() + kSavedNetworkBackoffMs;
  }
  if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
  else if (WiFi.getMode() == WIFI_AP) WiFi.mode(WIFI_AP_STA);
  WiFi.scanDelete();
  const int result = WiFi.scanNetworks(true, false);
  scan_.scanning = result == WIFI_SCAN_RUNNING || result >= 0;
  scan_.failed = !scan_.scanning;
  scanStartedAt_ = millis();
  ++scan_.revision;
  if (!portalJoinPending_ && !savedJoinPending_) publishWifi(
    scan_.failed ? WifiConnectionPhase::Failed : WifiConnectionPhase::Scanning,
    scan_.failed ? "Network scan unavailable; try again" : "Scanning nearby networks");
  return scan_.scanning;
}

void Provisioning::cancelWifiScan() {
  if (!scan_.scanning) return;
  esp_wifi_scan_stop();
  WiFi.scanDelete();
  scan_.scanning = false;
  ++scan_.revision;
  publishWifi(WiFi.status() == WL_CONNECTED ? WifiConnectionPhase::Connected : WifiConnectionPhase::Idle,
    "Network scan cancelled");
}

void Provisioning::pollWifiScan() {
  if (!scan_.scanning) return;
  const int found = WiFi.scanComplete();
  if (found == WIFI_SCAN_RUNNING && millis() - scanStartedAt_ < kScanTimeoutMs) return;
  scan_.scanning = false;
  scan_.failed = found < 0;
  if (found == WIFI_SCAN_RUNNING) esp_wifi_scan_stop();
  if (found >= 0) {
    scan_.count = 0;
    const auto profiles = store_->savedWifiNetworksSnapshot();
    // ESP-IDF sorts scan records by signal. Bound work even in an unusually dense deployment.
    const int inspected = found < 128 ? found : 128;
    for (int i = 0; i < inspected; ++i) {
      WifiScanNetwork row;
      row.ssid = WiFi.SSID(i);
      if (row.ssid.length() == 0 || row.ssid.length() > 32) continue;
      row.rssi = WiFi.RSSI(i);
      const auto auth = WiFi.encryptionType(i);
      row.secured = auth != WIFI_AUTH_OPEN;
      row.supported = auth == WIFI_AUTH_OPEN || auth == WIFI_AUTH_WPA_PSK
        || auth == WIFI_AUTH_WPA2_PSK || auth == WIFI_AUTH_WPA_WPA2_PSK
        || auth == WIFI_AUTH_WPA3_PSK || auth == WIFI_AUTH_WPA2_WPA3_PSK;
      for (const auto& profile : profiles) if (profile.ssid == row.ssid) row.saved = true;
      size_t index = scan_.count;
      for (size_t j = 0; j < scan_.count; ++j) if (scan_.networks[j].ssid == row.ssid) { index = j; break; }
      if (index < scan_.count && scan_.networks[index].rssi >= row.rssi) continue;
      if (index == scan_.count) {
        if (scan_.count < kMaxWifiScanNetworks) ++scan_.count;
        else {
          index = scan_.count - 1;
          if (scan_.networks[index].rssi >= row.rssi) continue;
        }
      }
      scan_.networks[index] = row;
      // Insertion sort maintains the strongest twelve unique SSIDs with bounded storage.
      while (index > 0 && scan_.networks[index].rssi > scan_.networks[index - 1].rssi) {
        const auto previous = scan_.networks[index - 1];
        scan_.networks[index - 1] = scan_.networks[index];
        scan_.networks[index] = previous;
        --index;
      }
    }
    scanCachedAt_ = millis();
  }
  WiFi.scanDelete();
  ++scan_.revision;
  publishWifi(scan_.failed ? WifiConnectionPhase::Failed
    : WiFi.status() == WL_CONNECTED ? WifiConnectionPhase::Connected : WifiConnectionPhase::Idle,
    scan_.failed ? "Network scan failed; try again" : "Network scan complete");
}

bool Provisioning::validateWifiCandidate(const String& ssid, const String& password, bool saved) {
  if (!store_) return false;
  if (ssid.length() == 0 || ssid.length() > 32 || password.length() > 64
      || (password.length() > 0 && password.length() < 8)) {
    publishWifi(WifiConnectionPhase::Failed, "Check network name and password length");
    return false;
  }
  if (password.length() == 64) {
    for (size_t i = 0; i < password.length(); ++i) {
      const char c = password[i];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
        publishWifi(WifiConnectionPhase::Failed, "A 64-character Wi-Fi key must be hexadecimal");
        return false;
      }
    }
  }
  for (size_t i = 0; i < ssid.length(); ++i) if (ssid[i] == '\0') {
    publishWifi(WifiConnectionPhase::Failed, "Invalid network name");
    return false;
  }
  for (size_t i = 0; i < password.length(); ++i) {
    const auto c = static_cast<uint8_t>(password[i]);
    if (c < 32 || c > 126) {
      publishWifi(WifiConnectionPhase::Failed, "Use printable Wi-Fi password characters");
      return false;
    }
  }
  const auto profiles = store_->savedWifiNetworksSnapshot();
  bool known = false;
  for (const auto& profile : profiles) if (profile.ssid == ssid) known = true;
  if (!saved && !known && profiles.size() >= kMaxSavedWifiNetworks) {
    publishWifi(WifiConnectionPhase::Failed, "Remove a saved network first");
    return false;
  }
  for (size_t i = 0; i < scan_.count; ++i) if (scan_.networks[i].ssid == ssid && !scan_.networks[i].supported) {
    publishWifi(WifiConnectionPhase::Failed, "This network security is unsupported");
    return false;
  }
  for (size_t i = 0; i < scan_.count; ++i) if (scan_.networks[i].ssid == ssid
      && scan_.networks[i].secured && password.length() == 0) {
    publishWifi(WifiConnectionPhase::Failed, "Enter this network's password");
    return false;
  }
  return true;
}

bool Provisioning::startWifiCandidate(const String& ssid, const String& password, bool saved, bool fromPortal) {
  if (!store_ || portalJoinPending_ || !validateWifiCandidate(ssid, password, saved)) return false;
  cancelWifiScan();
  pendingSsid_ = ssid; // Copy before disconnect; caller may release its input fields immediately.
  pendingPassword_ = password;
  pendingGateway_ = "";
  candidateSaved_ = saved;
  candidateFromPortal_ = fromPortal;
  if (++wifi_.candidateId == 0) ++wifi_.candidateId;
  wifi_.candidateResult = WifiCandidateResult::Pending;
  wifi_.candidateDetail = "Connecting; not saved yet";
  portalJoinPending_ = true;
  savedJoinPending_ = false;
  savedBeginPending_ = false;
  savedAttemptPassword_ = "";
  portalRecoveryPending_ = false;
  portalJoinStartedAt_ = millis();
  if (!portalUp_) status_.state = ProvisioningState::Connecting;
  status_.detail = "Trying selected network";
  WiFi.mode(portalUp_ ? WIFI_AP_STA : WIFI_STA);
  WiFi.disconnect(false, false, 0);
  candidateBeginPending_ = true;
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(pendingSsid_.c_str(), pendingPassword_.c_str());
    candidateBeginPending_ = false;
  }
  publishWifi(WifiConnectionPhase::Joining, "Connecting; saved networks kept until success");
  return true;
}

bool Provisioning::tryWifiNetwork(const String& ssid, const String& password) {
  return startWifiCandidate(ssid, password, false, false);
}

bool Provisioning::connectSavedWifiNetwork(const String& ssid) {
  if (!store_) return false;
  const auto profiles = store_->savedWifiNetworksSnapshot();
  for (const auto& profile : profiles) if (profile.ssid == ssid) return startWifiCandidate(profile.ssid, profile.password, true, false);
  publishWifi(WifiConnectionPhase::Failed, "Saved network no longer available");
  return false;
}

void Provisioning::failWifiCandidate(const String& reason, bool cancelled) {
  wifi_.candidateResult = cancelled ? WifiCandidateResult::Cancelled : WifiCandidateResult::Failed;
  wifi_.candidateDetail = reason;
  portalError_ = reason;
  portalJoinPending_ = false;
  candidateBeginPending_ = false;
  pendingSsid_ = "";
  pendingPassword_ = "";
  pendingGateway_ = "";
  WiFi.disconnect(false, false, 0);
  savedJoinPending_ = false;
  savedBeginPending_ = false;
  savedAttemptPassword_ = "";
  nextSavedIndex_ = 0;
  savedAttempts_ = 0;
  nextSavedAttemptAt_ = millis() + 1000;
  status_.detail = reason;
  if (!portalUp_ && (!store_ || !store_->hasWifiCredentials())) {
    if (phone_.active && phone_.hotspotHandoff) {
      phonePortalClosed_ = true;
      status_.state = ProvisioningState::Unprovisioned;
    } else enterProvisioning();
  }
  publishWifi(WifiConnectionPhase::Failed, reason);
}

void Provisioning::cancelWifiJoin() {
  if (!portalJoinPending_) return;
  failWifiCandidate("Join cancelled; saved networks kept", true);
}

void Provisioning::startSavedAttempt(bool keepPortal) {
  if (!store_ || portalJoinPending_ || scan_.scanning) return;
  const auto profiles = store_->savedWifiNetworksSnapshot();
  if (profiles.empty()) { if (!portalUp_) enterProvisioning(); return; }
  const size_t index = nextSavedIndex_ % profiles.size();
  savedAttemptSsid_ = profiles[index].ssid;
  nextSavedIndex_ = (index + 1) % profiles.size();
  savedJoinPending_ = true;
  connectStartedAt_ = millis();
  WiFi.mode(keepPortal ? WIFI_AP_STA : WIFI_STA);
  WiFi.disconnect(false, false, 0);
  savedAttemptPassword_ = profiles[index].password;
  savedBeginPending_ = true;
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(savedAttemptSsid_.c_str(), savedAttemptPassword_.c_str());
    savedAttemptPassword_ = "";
    savedBeginPending_ = false;
  }
  const auto settings = store_->transportSnapshot();
  publishWifi(savedAttemptSsid_ != settings.wifiSsid ? WifiConnectionPhase::TryingAlternate : WifiConnectionPhase::Joining,
    savedAttemptSsid_ != settings.wifiSsid ? "Trying another saved network" : "Reconnecting saved network");
}

void Provisioning::pollSavedJoin(bool keepPortal) {
  if (!store_ || portalJoinPending_ || scan_.scanning) return;
  if (!savedJoinPending_) {
    if ((int32_t)(millis() - nextSavedAttemptAt_) >= 0) startSavedAttempt(keepPortal);
    return;
  }
  if (savedBeginPending_) {
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.begin(savedAttemptSsid_.c_str(), savedAttemptPassword_.c_str());
      savedAttemptPassword_ = "";
      savedBeginPending_ = false;
    } else if (millis() - connectStartedAt_ >= kJoinTimeoutMs) {
      savedJoinPending_ = false;
      savedBeginPending_ = false;
      savedAttemptPassword_ = "";
      nextSavedAttemptAt_ = millis() + kSavedNetworkBackoffMs;
      publishWifi(WifiConnectionPhase::Failed, "Radio did not disconnect; retrying shortly");
    }
    return;
  }
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == savedAttemptSsid_) {
    const auto previous = store_->transportSnapshot();
    const bool activated = store_->activateSavedWifiNetwork(savedAttemptSsid_);
    savedJoinPending_ = false;
    savedBeginPending_ = false;
    savedAttemptPassword_ = "";
    savedAttempts_ = 0;
    nextSavedIndex_ = 0;
    status_.joinFailures = 0;
    knownGoodNetwork_ = true;
    justConnected_ = true;
    status_.detail = WiFi.localIP().toString();
    if (!configPortal_) {
      stopPortal();
      WiFi.mode(WIFI_STA);
      status_.state = ProvisioningState::Online;
    }
    publishWifi(WifiConnectionPhase::Connected, !activated ? "Connected; active preference could not be saved"
      : previous.wifiSsid != savedAttemptSsid_ ? "Switched to another saved network" : "Connected to saved network");
    return;
  }
  if (millis() - connectStartedAt_ < kJoinTimeoutMs) return;
  savedJoinPending_ = false;
  savedBeginPending_ = false;
  savedAttemptPassword_ = "";
  WiFi.disconnect(false, false, 0);
  if (status_.joinFailures < UINT8_MAX) ++status_.joinFailures;
  ++savedAttempts_;
  const size_t count = store_->savedWifiNetworksSnapshot().size();
  const size_t initialAttempts = count > kMaxJoinFailures ? count : kMaxJoinFailures;
  if (!knownGoodNetwork_ && !keepPortal && !phonePortalClosed_ && savedAttempts_ >= initialAttempts) {
    portalError_ = "Saved networks unavailable; choose or correct a network";
    enterProvisioning();
    nextSavedAttemptAt_ = millis() + kSavedNetworkBackoffMs;
  } else {
    nextSavedAttemptAt_ = millis() + (count != 0 && savedAttempts_ % count == 0 ? kSavedNetworkBackoffMs : 250);
    publishWifi(WifiConnectionPhase::TryingAlternate, "Saved network unavailable; trying alternatives");
  }
}

void Provisioning::enterConnecting() {
  configPortal_ = false;
  portalJoinPending_ = false;
  candidateBeginPending_ = false;
  portalRecoveryPending_ = false;
  pendingSsid_ = "";
  pendingPassword_ = "";
  pendingGateway_ = "";
  stopPortal();
  status_.state = ProvisioningState::Connecting;
  savedJoinPending_ = false;
  savedBeginPending_ = false;
  savedAttemptPassword_ = "";
  nextSavedIndex_ = 0;
  savedAttempts_ = 0;
  nextSavedAttemptAt_ = millis();
  startSavedAttempt(false);
}

void Provisioning::resetToProvisioning() {
  if (phone_.active) endPhoneSetup();
  if (store_ != nullptr && !store_->resetForProvisioning()) {
    publishWifi(WifiConnectionPhase::Failed, "Network reset failed; saved settings kept");
    return;
  }
  if (portalJoinPending_) {
    portalJoinPending_ = false;
    candidateBeginPending_ = false;
    wifi_.candidateResult = WifiCandidateResult::Cancelled;
    wifi_.candidateDetail = "Join cancelled by network reset";
  }
  status_.joinFailures = 0;
  knownGoodNetwork_ = false;
  nextSavedIndex_ = 0;
  savedAttempts_ = 0;
  portalError_ = "";
  enterProvisioning();
}

void Provisioning::openConfigPortal() {
  if (phone_.active) endPhoneSetup();
  phonePortalClosed_ = false;
  status_.joinFailures = 0;
  portalError_ = "Update the gateway URL, then Save.";
  configPortal_ = store_ != nullptr && store_->hasWifiCredentials();
  enterProvisioning(configPortal_);
}

void Provisioning::closeConfigPortal() {
  if (phone_.active) { endPhoneSetup(); return; }
  if (!configPortal_) return;
  if (portalJoinPending_) {
    cancelWifiJoin();
    // Closing setup cancels an uncommitted candidate, even if it has just associated. Only the
    // stored network is authoritative until pollPortalJoin validates and persists the candidate.
    portalJoinPending_ = false;
    portalRecoveryPending_ = false;
    pendingPassword_ = "";
    pendingSsid_ = "";
    pendingGateway_ = "";
    portalError_ = "";
    discovered_ = "";
    enterConnecting();
    return;
  }
  configPortal_ = false;
  discovered_ = "";
  portalError_ = "";
  stopPortal();

  // The station never dropped — the portal ran AP_STA — so this is a return to what the device was
  // already doing, not a fresh join. Going through Connecting would tear down a working link and
  // re-establish it for no reason.
  if (WiFi.status() == WL_CONNECTED) {
    WiFi.mode(WIFI_STA);
    status_.state = ProvisioningState::Online;
    knownGoodNetwork_ = true;
    status_.detail = WiFi.localIP().toString();
    justConnected_ = true;
    Serial.println("[wifi] config portal closed; back online");
  } else {
    enterConnecting();
  }
}

bool Provisioning::consumeJustConnected() {
  const bool value = justConnected_;
  justConnected_ = false;
  return value;
}

ProvisioningState Provisioning::poll() {
  pollPhoneSetup();
  pollWifiScan();
  if (phone_.active && portalUp_ && status_.state != ProvisioningState::Provisioning) {
    dns_.processNextRequest();
    server_.handleClient();
  }
  if (portalJoinPending_) pollPortalJoin();
  switch (status_.state) {
    case ProvisioningState::Unprovisioned:
      if (!phonePortalClosed_) enterProvisioning();
      break;
    case ProvisioningState::Provisioning:
      dns_.processNextRequest();
      server_.handleClient();
      pollPortalJoin();
      if (WiFi.softAPgetStationNum() > 0) portalLastClientAt_ = millis();
      if (store_->hasWifiCredentials() && !portalJoinPending_
          && millis() - portalLastClientAt_ > kPortalIdleTimeoutMs) enterConnecting();
      break;
    case ProvisioningState::Connecting:
      if (!portalJoinPending_) pollSavedJoin(false);
      break;
    case ProvisioningState::Online:
      if (WiFi.status() != WL_CONNECTED && !portalJoinPending_) {
        nextSavedIndex_ = 0;
        savedAttempts_ = 0;
        publishWifi(WifiConnectionPhase::TryingAlternate, "Connection lost; trying saved networks");
        enterConnecting();
      }
      break;
    case ProvisioningState::Failed:
      enterProvisioning();
      break;
  }
  return status_.state;
}

void Provisioning::startPortal(bool keepStation) {
  if (portalUp_) return;
  // Every step is checked and logged. A portal that reports itself up while the radio silently
  // refused to start is indistinguishable, from the owner's side, from a dead device.
  // AP_STA when reconfiguring, so the owner reaches the portal over the device's own AP while the
  // device stays on their network and can still see the gateway.
  const bool modeOk = WiFi.mode(keepStation ? WIFI_AP_STA : WIFI_AP);
  const String setupName = phone_.active ? phone_.apName : apName_;
  status_.apName = setupName;
  const bool apOk = phone_.active
    ? WiFi.softAP(setupName.c_str(), phone_.apPassword.c_str())
    : WiFi.softAP(setupName.c_str());
  const IPAddress ip = WiFi.softAPIP();
  Serial.printf(
    "[wifi] softAP mode=%d ap=%d ip=%s channel=%d\n",
    modeOk ? 1 : 0, apOk ? 1 : 0, ip.toString().c_str(), WiFi.channel()
  );
  if (!apOk) {
    status_.detail = "Radio failed";
    Serial.println("[wifi] softAP() refused; the portal is NOT broadcasting");
    return;
  }
  dns_.start(kDnsPort, "*", ip);

  // Routes are registered once for the lifetime of the object. WebServer::on() appends rather than
  // replaces, so re-registering on every retry would leak a handler per failed join attempt.
  if (!routesRegistered_) {
    server_.on("/", HTTP_GET, [this]() { handlePortalRoot(); });
    server_.on("/save", HTTP_POST, [this]() { handlePortalSubmit(); });
    server_.on("/phone/status", HTTP_GET, [this]() { handlePhoneStatus(); });
    server_.on("/phone/connect", HTTP_POST, [this]() { handlePhoneConnect(); });
    server_.on("/phone/scan", HTTP_POST, [this]() { handlePhoneScan(); });
    server_.on("/phone/finish", HTTP_POST, [this]() { handlePhoneFinish(); });
    const char* headers[] = {"Origin", "Sec-Fetch-Site", "X-Setup-Token", "Content-Length"};
    server_.collectHeaders(headers, 4);
    server_.onNotFound([this]() { handlePortalNotFound(); });
    routesRegistered_ = true;
  }
  server_.begin();

  portalUp_ = true;
  portalLastClientAt_ = millis();
  nextPortalRecoveryAt_ = millis() + 30000;
  Serial.printf("[wifi] portal up: SSID %s at %s\n", apName_.c_str(), status_.portalUrl.c_str());
}

void Provisioning::stopPortal() {
  if (!portalUp_) return;
  server_.stop();
  dns_.stop();
  WiFi.softAPdisconnect(true);
  portalUp_ = false;
  Serial.println("[wifi] portal down");
}

PhoneSetupSnapshot Provisioning::phoneSetupSnapshot() const {
  PhoneSetupSnapshot snapshot = phone_;
  if (snapshot.active) {
    const int32_t remaining = static_cast<int32_t>(phoneExpiresAt_ - millis());
    snapshot.expiresInSeconds = remaining > 0 ? (static_cast<uint32_t>(remaining) + 999) / 1000 : 0;
    const int32_t hotspotRemaining = static_cast<int32_t>(phoneHotspotDeadline_ - millis());
    snapshot.remainingSeconds = snapshot.waitingForHotspot && hotspotRemaining > 0
      ? (static_cast<uint32_t>(hotspotRemaining) + 999) / 1000 : 0;
  }
  return snapshot;
}

bool Provisioning::beginPhoneSetup() {
  if (!store_) return false;
  if (phone_.active) return true;
  if (portalJoinPending_) {
    phone_.phase = PhoneSetupPhase::Failed;
    phone_.detail = "A Wi-Fi attempt is pending; wait for its result first";
    ++phone_.revision;
    return false;
  }
  cancelWifiScan();
  stopPortal();
  phone_ = PhoneSetupSnapshot();
  phone_.active = true;
  phone_.phase = PhoneSetupPhase::Ready;
  phone_.apName = apName_ + "-setup";
  phone_.portalUrl = "http://192.168.4.1";
  phone_.detail = "Scan to join setup Wi-Fi, then open the setup page";
  uint8_t random[32];
  esp_fill_random(random, sizeof(random));
  static const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 16; ++i) phone_.apPassword += alphabet[random[i] & 31];
  phoneNonce_ = "";
  for (size_t i = 16; i < 32; ++i) { phoneNonce_ += hex[random[i] >> 4]; phoneNonce_ += hex[random[i] & 15]; }
  phoneRequestId_ = "";
  phoneQueuedSsid_ = "";
  phoneQueuedPassword_ = "";
  phoneStartAt_ = 0;
  phoneFinishAt_ = 0;
  phoneExpiresAt_ = millis() + 10UL * 60UL * 1000UL;
  phonePortalClosed_ = false;
  configPortal_ = store_->hasWifiCredentials();
  enterProvisioning(configPortal_);
  if (!portalUp_) {
    phone_.active = false;
    phone_.phase = PhoneSetupPhase::Failed;
    phone_.detail = "Setup Wi-Fi could not start; try again";
    phone_.apPassword = "";
    phoneNonce_ = "";
    ++phone_.revision;
    return false;
  }
  startWifiScan();
  ++phone_.revision;
  return true;
}

void Provisioning::endPhoneSetup() {
  if (!phone_.active) return;
  phoneStartAt_ = 0;
  phoneQueuedPassword_ = "";
  phoneQueuedSsid_ = "";
  if (portalJoinPending_ && wifi_.candidateId == phone_.candidateId) cancelWifiJoin();
  if (phone_.candidateResult == WifiCandidateResult::Pending) phone_.candidateResult = WifiCandidateResult::Cancelled;
  phone_.active = false;
  phone_.waitingForHotspot = false;
  phoneHotspotDeadline_ = 0;
  phone_.phase = PhoneSetupPhase::Inactive;
  phone_.detail = "Phone setup closed";
  phone_.apPassword = "";
  phoneNonce_ = "";
  phoneFinishAt_ = 0;
  stopPortal();
  configPortal_ = false;
  status_.apName = apName_;
  WiFi.mode(WIFI_STA);
  if (WiFi.status() == WL_CONNECTED) {
    status_.state = ProvisioningState::Online;
    status_.detail = WiFi.localIP().toString();
    knownGoodNetwork_ = true;
    justConnected_ = true;
    publishWifi(WifiConnectionPhase::Connected, "Phone setup closed; network connected");
  } else if (store_->hasWifiCredentials()) enterConnecting();
  else {
    phonePortalClosed_ = true;
    status_.state = ProvisioningState::Unprovisioned;
    status_.detail = "Open phone setup on the device to connect Wi-Fi";
    publishWifi(WifiConnectionPhase::Idle, status_.detail);
  }
  ++phone_.revision;
}

bool Provisioning::queuePhoneNetwork(const String& requestId, const String& ssid, const String& password,
                                     bool saved, const String& previousRequestId, bool hotspot) {
  if (!phone_.active || static_cast<int32_t>(millis() - phoneExpiresAt_) >= 0) return false;
  if (hotspot && saved) return false;
  if (requestId.length() < 8 || requestId.length() > 64) return false;
  for (size_t i = 0; i < requestId.length(); ++i) {
    const char c = requestId[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
  }
  // A lost HTTP response may be checked/repeated with the SAME receipt; it never starts again.
  if (requestId == phoneRequestId_) return true;
  if (previousRequestId != phoneRequestId_ || phone_.phase == PhoneSetupPhase::Succeeded
      || phone_.phase == PhoneSetupPhase::Queued || phone_.phase == PhoneSetupPhase::Joining
      || phone_.hotspotHandoff) return false;
  String candidatePassword = password;
  if (saved) {
    bool found = false;
    for (const auto& profile : store_->savedWifiNetworksSnapshot()) if (profile.ssid == ssid) {
      candidatePassword = profile.password;
      found = true;
      break;
    }
    if (!found) return false;
  }
  if (!validateWifiCandidate(ssid, candidatePassword, saved)) {
    phone_.phase = PhoneSetupPhase::Failed;
    phone_.candidateResult = WifiCandidateResult::Failed;
    phone_.detail = wifi_.detail;
    ++phone_.revision;
    return false;
  }
  phoneRequestId_ = requestId;
  phoneQueuedSsid_ = ssid;
  phoneQueuedPassword_ = candidatePassword;
  phoneQueuedSaved_ = saved;
  phone_.hotspotHandoff = hotspot;
  phone_.waitingForHotspot = false;
  phoneHotspotDeadline_ = 0;
  phone_.phase = PhoneSetupPhase::Queued;
  phone_.candidateId = 0;
  phone_.candidateResult = WifiCandidateResult::Pending;
  phone_.detail = "Request accepted; connecting next";
  // The HTTP handler sends its receipt before poll() changes station/AP channels. flush() alone
  // is a no-op in this Arduino NetworkClient; a separate tick gives TCP time to deliver it.
  phoneStartAt_ = millis() + (hotspot ? 750 : 300);
  if (hotspot) phoneExpiresAt_ = millis() + 131000; // full handoff plus receipt and success grace
  phoneFinishAt_ = 0;
  ++phone_.revision;
  return true;
}

void Provisioning::pollPhoneSetup() {
  if (!phone_.active) return;
  if (static_cast<int32_t>(millis() - phoneExpiresAt_) >= 0
      || (phoneFinishAt_ != 0 && static_cast<int32_t>(millis() - phoneFinishAt_) >= 0)) {
    endPhoneSetup();
    return;
  }
  if (phoneStartAt_ != 0 && static_cast<int32_t>(millis() - phoneStartAt_) >= 0) {
    phoneStartAt_ = 0;
    const String ssid = phoneQueuedSsid_;
    const String password = phoneQueuedPassword_;
    phoneQueuedSsid_ = "";
    phoneQueuedPassword_ = "";
    if (phone_.hotspotHandoff) {
      stopPortal();
      phone_.apPassword = "";
      phoneNonce_ = "";
      phonePortalClosed_ = true;
      configPortal_ = false;
      WiFi.mode(WIFI_STA);
      phoneHotspotDeadline_ = millis() + 120000;
    }
    const bool accepted = startWifiCandidate(ssid, password, phoneQueuedSaved_, true);
    phone_.candidateId = accepted ? wifi_.candidateId : 0;
    phone_.candidateResult = accepted ? WifiCandidateResult::Pending : WifiCandidateResult::Failed;
    phone_.waitingForHotspot = accepted && phone_.hotspotHandoff;
    phone_.phase = accepted ? (phone_.hotspotHandoff ? PhoneSetupPhase::WaitingHotspot : PhoneSetupPhase::Joining) : PhoneSetupPhase::Failed;
    phone_.detail = accepted ? (phone_.hotspotHandoff ? "Enable phone hotspot and Maximize Compatibility; waiting up to two minutes" : "Connecting; previous networks remain saved") : wifi_.detail;
    ++phone_.revision;
  }
  if (phone_.waitingForHotspot && portalJoinPending_
      && static_cast<int32_t>(millis() - phoneHotspotDeadline_) >= 0)
    failWifiCandidate("Hotspot not connected in two minutes; previous networks kept");
  if ((phone_.phase == PhoneSetupPhase::Joining || phone_.phase == PhoneSetupPhase::WaitingHotspot) && phone_.candidateId == wifi_.candidateId
      && (wifi_.candidateResult == WifiCandidateResult::Failed || wifi_.candidateResult == WifiCandidateResult::Cancelled)) {
    phone_.phase = PhoneSetupPhase::Failed;
    phone_.waitingForHotspot = false;
    phoneHotspotDeadline_ = 0;
    phone_.candidateResult = wifi_.candidateResult;
    phone_.detail = wifi_.candidateDetail;
    ++phone_.revision;
  }
}

void Provisioning::phoneHeaders() {
  server_.sendHeader("Cache-Control", "no-store");
  server_.sendHeader("X-Content-Type-Options", "nosniff");
  server_.sendHeader("X-Frame-Options", "DENY");
}

bool Provisioning::phoneRequestAllowed(bool requireToken) {
  const String host = WiFi.softAPIP().toString();
  const String origin = String("http://") + host;
  if (!phone_.active || !portalUp_ || phoneNonce_.length() == 0
      || static_cast<int32_t>(millis() - phoneExpiresAt_) >= 0
      || server_.client().localIP() != WiFi.softAPIP()
      || (server_.hostHeader() != host && server_.hostHeader() != host + ":80")
      || (server_.header("Origin").length() > 0 && server_.header("Origin") != origin)
      || server_.header("Sec-Fetch-Site") == "cross-site") {
    phoneHeaders();
    server_.send(403, "text/plain", "Open this page on the controller's setup Wi-Fi.");
    return false;
  }
  if (requireToken) {
    const String supplied = server_.header("X-Setup-Token");
    unsigned mismatch = supplied.length() == phoneNonce_.length() ? 0 : 1;
    for (size_t i = 0; i < phoneNonce_.length(); ++i) mismatch |= static_cast<uint8_t>(phoneNonce_[i])
      ^ (i < supplied.length() ? static_cast<uint8_t>(supplied[i]) : 0);
    if (mismatch) {
      phoneHeaders();
      server_.send(403, "text/plain", "Setup session changed. Reload its page.");
      return false;
    }
  }
  return true;
}

void Provisioning::handlePhoneRoot() {
  if (!phoneRequestAllowed(false)) return;
  phoneHeaders();
  server_.sendHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"
    + phoneNonce_ + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  String page;
  page.reserve(8200);
  page = R"HTML(<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Next Coder</title>
<style>body{margin:0;background:#111;color:#eee;font:16px system-ui,sans-serif}main{max-width:30rem;margin:auto;padding:1.3rem}h1{font-size:1.5rem}p{line-height:1.5}label{display:block;margin-top:1rem}input,select,button{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #555;border-radius:.6rem;background:#222;color:#eee;font:inherit;margin-top:.4rem}button{background:#b7a8ff;color:#111;font-weight:600}button.secondary{background:#222;color:#eee}button:disabled{opacity:.5}.status{padding:1rem;border:1px solid #777;border-radius:.6rem;white-space:pre-wrap}small{display:block;line-height:1.5;color:#bbb}#saved{color:#b7a8ff}</style>
<main><h1>Connect your controller</h1><p>This page talks directly to the controller. Your Wi-Fi password stays on it; it is never sent to the cloud.</p>
<small>Stay on the controller's setup Wi-Fi even if your phone says “No Internet.” Choose a <strong>2.4 GHz</strong> network. For an iPhone hotspot, enable <strong>Maximize Compatibility</strong> if offered, turn on <strong>Allow Others to Join</strong>, and keep its hotspot settings open. For this same phone, use the hotspot handoff below: enter its hotspot name and password first, then enable its hotspot after acceptance.</small>
<p id="status" class="status" role="status" aria-live="polite">Loading nearby networks…</p><small id="current"></small>
<form id="networkForm"><label for="networks">1. Choose a nearby or saved network</label><select id="networks"><option value="">Choose a network</option></select><button class="secondary" id="scan" type="button">Refresh nearby networks</button>
<label for="ssid">Or type its name (for a hidden network)</label><input id="ssid" name="ssid" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false"><small id="saved"></small>
<label for="password">2. Enter its Wi-Fi password</label><input id="password" name="password" type="password" maxlength="64" autocomplete="off"><small>Leave blank only for an open network. Saved passwords are never displayed.</small>
<small><strong>Using this phone’s hotspot?</strong> Type its exact hotspot name and password above. After acceptance setup Wi-Fi closes: enable Allow Others to Join and Maximize Compatibility, then leave hotspot settings open. The controller waits up to two minutes. This page becomes unreachable; check the controller for the result. Do not submit again.</small><button id="hotspot" class="secondary" type="button">Use this phone’s hotspot</button><button id="connect" type="submit">Connect and save after validation</button><button id="useSaved" class="secondary" type="button" hidden>Connect using saved password</button></form>
<button id="finish" class="secondary" type="button">Finish and close setup</button><small>Existing saved networks remain available if this attempt fails. After success this setup network closes automatically in ten seconds.</small></main>
)HTML";
  page += "<script nonce=\"" + phoneNonce_ + "\">const token='" + phoneNonce_ + "';";
  page += R"JS(
const $=id=>document.getElementById(id), status=$('status'), form=$('networkForm');
let pending=false, busy=false, listSignature='', saved=new Set(), finished=false, lastReceipt='';
function controls(){for(const el of form.elements)el.disabled=pending;$('useSaved').hidden=!saved.has($('ssid').value);$('saved').textContent=saved.has($('ssid').value)?'Saved network: you can reuse its password.':'';}
async function api(path, options={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);try{const response=await fetch(path,{...options,cache:'no-store',credentials:'omit',headers:{'X-Setup-Token':token,...options.headers},signal:controller.signal});if(response.status===403){$('password').value='';throw Error('Setup expired or Wi-Fi changed. Reopen phone setup on the controller.');}return {ok:response.ok,data:await response.json()};}finally{clearTimeout(timer);}}
function render(data){lastReceipt=data.requestId||'';const signature=JSON.stringify([data.networks,data.savedNetworks]);saved=new Set(data.savedNetworks||[]);if(signature!==listSignature){const previous=$('networks').value;$('networks').replaceChildren(new Option('Choose a network',''));const seen=new Set();for(const row of data.networks||[]){const option=new Option(row.ssid+(row.supported?(row.saved?' · saved':'')+(row.secured?' · secured':' · open'):' · unsupported security'),row.ssid);option.disabled=!row.supported;$('networks').add(option);seen.add(row.ssid);}for(const name of saved)if(!seen.has(name))$('networks').add(new Option(name+' · saved (not seen nearby)',name));$('networks').value=previous;listSignature=signature;}
 pending=data.phase==='queued'||data.phase==='joining'||data.phase==='waiting-hotspot';status.textContent=data.detail+(data.scanning?'\nScanning nearby networks…':data.scanFailed?'\nScan unavailable. Refresh or type the network name.':'');$('current').textContent=data.activeSsid?'Currently connected: '+data.activeSsid:'No Wi-Fi connection yet.';if(data.phase==='saved'){form.hidden=true;pending=false;}controls();}
async function refresh(){if(busy||finished||document.hidden)return;busy=true;try{const result=await api('/phone/status');if(result.ok)render(result.data);}catch(error){status.textContent=error.message.startsWith('Setup expired')?error.message:'Status unavailable. Stay on setup Wi-Fi and check the controller. Do not send the request again; status checks will resume.';}finally{busy=false;}}
$('networks').onchange=()=>{$('ssid').value=$('networks').value;controls();};$('ssid').oninput=controls;
$('scan').onclick=async()=>{try{const result=await api('/phone/scan',{method:'POST'});status.textContent=result.ok?'Scanning nearby networks…':result.data.error;}catch{status.textContent='Scan status unavailable. Rejoin setup Wi-Fi and refresh.';}};
function requestId(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
async function connect(useSaved,hotspot=false){if(pending)return;const body=new URLSearchParams({requestId:requestId(),previousRequestId:lastReceipt,ssid:$('ssid').value,password:useSaved?'':$('password').value,mode:hotspot?'hotspot':useSaved?'saved':'password'});pending=true;controls();status.textContent='Sending one connection request…';try{const result=await api('/phone/connect',{method:'POST',body});$('password').value='';if(result.ok){if(result.data.hotspotHandoff){finished=true;form.hidden=true;$('finish').hidden=true;status.textContent='Accepted. Setup Wi-Fi is closing. Now enable Allow Others to Join and Maximize Compatibility in your phone hotspot settings, and leave them open. Check the controller within two minutes for its result. This page will be unreachable. Do not submit again.';return;}status.textContent='Request accepted. Connecting; keep this page open.';}else{pending=false;controls();status.textContent=result.data.error;}}catch{if(hotspot){finished=true;form.hidden=true;status.textContent='Receipt unavailable. Check the controller: if Waiting for hotspot, enable Allow Others to Join and Maximize Compatibility now. Do not submit again. If it still shows setup QR, reconnect setup Wi-Fi and check status.';return;}status.textContent='Delivery is uncertain. Do not press Connect again. Keep setup Wi-Fi connected; this page will check the original request.';}await refresh();}
form.onsubmit=event=>{event.preventDefault();connect(false);};$('useSaved').onclick=()=>connect(true);$('hotspot').onclick=()=>connect(false,true);
$('finish').onclick=async()=>{try{const result=await api('/phone/finish',{method:'POST'});if(result.ok){finished=true;$('password').value='';status.textContent='Setup is closing. Check the controller for its Wi-Fi result.';form.hidden=true;}}catch{status.textContent='Close setup on the controller if this page cannot reach it.';}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(refresh,1500);refresh();
</script></html>)JS";
  server_.send(200, "text/html; charset=utf-8", page);
}

void Provisioning::handlePhoneStatus() {
  if (!phoneRequestAllowed()) return;
  JsonDocument doc;
  const char* phase = phone_.phase == PhoneSetupPhase::Ready ? "ready"
    : phone_.phase == PhoneSetupPhase::Queued ? "queued" : phone_.phase == PhoneSetupPhase::Joining ? "joining"
    : phone_.phase == PhoneSetupPhase::WaitingHotspot ? "waiting-hotspot"
    : phone_.phase == PhoneSetupPhase::Succeeded ? "saved" : "failed";
  doc["phase"] = phase;
  doc["detail"] = phone_.detail;
  doc["requestId"] = phoneRequestId_;
  doc["candidateId"] = phone_.candidateId;
  doc["activeSsid"] = wifi_.activeSsid;
  doc["scanning"] = scan_.scanning;
  doc["scanFailed"] = scan_.failed;
  doc["expiresInSeconds"] = phoneSetupSnapshot().expiresInSeconds;
  JsonArray rows = doc["networks"].to<JsonArray>();
  for (size_t i = 0; i < scan_.count; ++i) {
    const auto& network = scan_.networks[i];
    JsonObject row = rows.add<JsonObject>();
    row["ssid"] = network.ssid;
    row["rssi"] = network.rssi;
    row["secured"] = network.secured;
    row["supported"] = network.supported;
    row["saved"] = network.saved;
  }
  JsonArray saved = doc["savedNetworks"].to<JsonArray>();
  for (const auto& ssid : store_->savedWifiNamesSnapshot()) saved.add(ssid);
  String body;
  serializeJson(doc, body);
  phoneHeaders();
  server_.send(200, "application/json", body);
}

void Provisioning::handlePhoneConnect() {
  if (!phoneRequestAllowed()) return;
  const long length = server_.header("Content-Length").toInt();
  if (length <= 0 || length > 512) { phoneHeaders(); server_.send(413, "application/json", "{\"error\":\"Request is too large or missing its length.\"}"); return; }
  const String mode = server_.arg("mode");
  if (mode != "saved" && mode != "password" && mode != "hotspot") { phoneHeaders(); server_.send(400, "application/json", "{\"error\":\"Choose a supported connection mode.\"}"); return; }
  const bool accepted = queuePhoneNetwork(server_.arg("requestId"), server_.arg("ssid"), server_.arg("password"),
    server_.arg("mode") == "saved", server_.arg("previousRequestId"), server_.arg("mode") == "hotspot");
  JsonDocument doc;
  if (accepted) { doc["accepted"] = true; doc["requestId"] = phoneRequestId_; doc["hotspotHandoff"] = phone_.hotspotHandoff; }
  else doc["error"] = phone_.phase == PhoneSetupPhase::Queued || phone_.phase == PhoneSetupPhase::Joining
    ? String("A connection attempt is pending. Check status instead of sending again.")
    : phone_.phase == PhoneSetupPhase::Failed ? phone_.detail : String("Check the network and request, then try again.");
  String body;
  serializeJson(doc, body);
  phoneHeaders();
  server_.send(accepted ? 202 : 409, "application/json", body);
}

void Provisioning::handlePhoneScan() {
  if (!phoneRequestAllowed()) return;
  const bool accepted = scan_.scanning || startWifiScan();
  phoneHeaders();
  server_.send(accepted ? 202 : 409, "application/json", accepted ? "{\"accepted\":true}" : "{\"error\":\"A connection attempt is pending.\"}");
}

void Provisioning::handlePhoneFinish() {
  if (!phoneRequestAllowed()) return;
  phoneHeaders();
  server_.send(202, "application/json", "{\"accepted\":true}");
  phoneFinishAt_ = millis() + 300;
}

String Provisioning::scanOptionsHtml() {
  if (!scan_.scanning && (scanCachedAt_ == 0 || millis() - scanCachedAt_ >= kScanCacheMs)) startWifiScan();
  String options;
  for (size_t i = 0; i < scan_.count; ++i) {
    const auto& network = scan_.networks[i];
    if (!network.supported) continue;
    options += "<option value=\"" + htmlEscape(network.ssid) + "\">" + htmlEscape(network.ssid)
      + " (" + String(network.rssi) + " dBm)</option>";
  }
  return options;
}

void Provisioning::handlePortalRoot() {
  if (phone_.active) { handlePhoneRoot(); return; }
  portalLastClientAt_ = millis();
  String page =
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Next Coder setup</title><style>"
    "body{font-family:system-ui,sans-serif;margin:0;padding:1.5rem;background:#111211;color:#f1f1ef}"
    "main{max-width:24rem;margin:0 auto}h1{font-size:1.25rem}"
    "label{display:block;margin:1rem 0 .35rem;font-size:.8rem;color:#969795}"
    "input,select{width:100%;padding:.6rem;border-radius:.5rem;border:1px solid #343a38;"
    "background:#202120;color:#f1f1ef;font-size:1rem;box-sizing:border-box}"
    "button{width:100%;margin-top:1.25rem;padding:.75rem;border:0;border-radius:.5rem;"
    "background:#a9e85e;color:#0e1220;font-weight:600;font-size:1rem}"
    ".err{margin-top:1rem;padding:.75rem;border-radius:.5rem;background:#3a1d21;color:#ef8993;font-size:.85rem}"
    ".hint{margin-top:1.25rem;font-size:.75rem;color:#626360;line-height:1.5}"
    "</style></head><body><main>"
    "<h1>Connect this controller</h1>"
    "<p style=\"color:#969795;font-size:.85rem\">This page talks only to the controller. "
    "It never asks for your Next Coder account.</p>";

  if (portalError_.length() > 0) page += "<div class=\"err\">" + htmlEscape(portalError_) + "</div>";

  page += "<form method=\"POST\" action=\"/save\">"
    "<label for=\"ssid\">Wi-Fi network</label>"
    "<input id=\"ssid\" name=\"ssid\" list=\"networks\" maxlength=\"32\" autocomplete=\"off\">"
    "<datalist id=\"networks\">"
    // Blank keeps the saved network; typing also supports a hidden SSID while scans are pending.
    + String(store_->hasWifiCredentials()
        ? "<option value=\"\">Keep " + htmlEscape(store_->wifiSsid()) + "</option>"
        : "")
    + scanOptionsHtml() + "</datalist>"
    "<button type=\"submit\" name=\"action\" value=\"scan\">Refresh nearby networks</button>"
    "<label for=\"password\">Password</label>"
    "<input id=\"password\" name=\"password\" type=\"password\" maxlength=\"64\" autocomplete=\"off\">"
    "<label for=\"gateway\">Gateway URL</label>"
    "<input id=\"gateway\" name=\"gateway\" type=\"url\" value=\""
    + htmlEscape(discovered_.length() ? discovered_ : store_->gatewayUrl()) + "\">"
    // Only offered when the device is still on the owner's network. In first-time setup it is in
    // pure SoftAP mode, is not on that network, and the search could only time out — a button that
    // cannot work is worse than no button.
    + String(configPortal_
        ? "<button type=\"submit\" name=\"action\" value=\"discover\" class=\"secondary\">"
          "Find gateway on this network</button>"
          // Leaving without saving has to be possible: the owner may have opened this by accident,
          // or looked, found nothing wrong, and simply wants their device back.
          "<button type=\"submit\" name=\"action\" value=\"done\" class=\"secondary\">"
          "Done — back to the device</button>"
        : "")
    + "<button type=\"submit\">Save</button></form>"
    "<p class=\"hint\">To correct only the gateway, leave the network blank and press Save; "
    "the controller keeps the Wi-Fi it already has.</p>"
    "<p class=\"hint\">The controller tries the network before saving it, so a wrong password "
    "brings you back here instead of locking the device.</p>"
    "</main></body></html>";

  server_.send(200, "text/html; charset=utf-8", page);
}

void Provisioning::handlePortalSubmit() {
  if (phone_.active) { server_.send(403, "text/plain", "Use the guided Wi-Fi setup page."); return; }
  portalLastClientAt_ = millis();

  if (portalJoinPending_ && server_.arg("action") != "done") {
    server_.send(409, "text/plain", "A network join is already in progress. Wait for its result.");
    return;
  }

  if (server_.arg("action") == "done") {
    server_.send(
      200,
      "text/html; charset=utf-8",
      "<!doctype html><meta charset=\"utf-8\">"
      "<body style=\"font-family:system-ui;background:#111211;color:#f1f1ef;padding:1.5rem\">"
      "<p>Done. The controller is back on your network — this setup network has closed.</p>"
      "</body>"
    );
    server_.client().flush();
    closeConfigPortal();
    return;
  }

  if (server_.arg("action") == "discover") {
    const GatewayCandidate found = discoverGateway();
    if (found.found) {
      discovered_ = found.baseUrl;
      portalError_ = "Found " + (found.name.length() ? found.name : String("a gateway"))
                   + ". Press Save to use it.";
    } else {
      discovered_ = "";
      portalError_ = "No gateway answered on this network.";
    }
    handlePortalRoot();
    return;
  }

  if (server_.arg("action") == "scan") {
    startWifiScan();
    portalError_ = "Scanning nearby networks; refresh this page in a moment.";
    handlePortalRoot();
    return;
  }

  const String ssid = server_.arg("ssid");
  const String password = server_.arg("password");
  String gateway = server_.arg("gateway");
  gateway.trim();
  while (gateway.endsWith("/")) gateway.remove(gateway.length() - 1);
  if (gateway.length() > 0 && !gateway_tls::gatewayUrlAllowed(gateway)) {
    portalError_ = "Use verified HTTPS. Plain HTTP is allowed only for an explicit local bench build.";
    handlePortalRoot();
    return;
  }

  // Network credentials and gateway identity have separate commit boundaries. Do not change the
  // gateway first and then report a failed Wi-Fi save as though all old settings survived.
  const bool gatewayChange = gateway.length() > 0 && gateway != store_->transportSnapshot().gatewayUrl;
  if (ssid.length() > 0 && gatewayChange) {
    portalError_ = "Save the gateway separately with the network blank, then choose Wi-Fi.";
    handlePortalRoot();
    return;
  }

  if (ssid.length() == 0) {
    // A gateway-only correction. The owner reached this portal to fix a URL, and the stored
    // network is already known good — making them re-pick it and retype the password would be
    // asking for a second chance to get something wrong.
    if (gateway.length() > 0) {
      if (!store_->setGatewayUrl(gateway)) {
        portalError_ = "Gateway URL was not saved.";
        handlePortalRoot();
        return;
      }
      if (!store_->hasWifiCredentials()) {
        portalError_ = "Gateway saved. Choose a Wi-Fi network next.";
        handlePortalRoot();
        return;
      }
      Serial.println("[wifi] gateway settings saved; reconnecting");
      server_.send(
        200,
        "text/html; charset=utf-8",
        "<!doctype html><meta charset=\"utf-8\">"
        "<body style=\"font-family:system-ui;background:#111211;color:#f1f1ef;padding:1.5rem\">"
        "<p>Gateway saved. Reconnecting to your network…</p></body>"
      );
      server_.client().flush();
      portalError_ = "";
      enterConnecting();
      return;
    }
    portalError_ = "Choose a network.";
    handlePortalRoot();
    return;
  }

  // Join first, persist second. Writing credentials that do not work would put the device into a
  // reboot loop the owner cannot see the cause of.
  server_.send(
    200,
    "text/html; charset=utf-8",
    "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"12;url=/\">"
    "<body style=\"font-family:system-ui;background:#111211;color:#f1f1ef;padding:1.5rem\">"
    "<p>Trying that network… the controller screen shows the result. "
    "This page returns in a moment if it did not work.</p></body>"
  );
  server_.client().flush();

  // The HTTP handler is called from the render loop. Start association and let poll() complete
  // it; a wrong password must not freeze touch/render for the full 20-second join timeout.
  if (!startWifiCandidate(ssid, password, false, true)) portalError_ = wifi_.detail;

}

void Provisioning::pollPortalJoin() {
  if (portalJoinPending_) {
    if (candidateBeginPending_) {
      if (WiFi.status() != WL_CONNECTED) {
        WiFi.begin(pendingSsid_.c_str(), pendingPassword_.c_str());
        candidateBeginPending_ = false;
      } else if (millis() - portalJoinStartedAt_ >= kJoinTimeoutMs) {
        failWifiCandidate("Radio did not disconnect; saved networks kept");
      }
      return;
    }
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == pendingSsid_) {
      const bool saved = candidateSaved_ ? store_->activateSavedWifiNetwork(pendingSsid_)
                                         : store_->saveWifiNetwork(pendingSsid_, pendingPassword_);
      if (!saved) { failWifiCandidate("Connected, but settings could not be saved"); return; }
      pendingPassword_ = "";
      pendingSsid_ = "";
      pendingGateway_ = "";
      portalJoinPending_ = false;
      wifi_.candidateResult = WifiCandidateResult::Succeeded;
      wifi_.candidateDetail = candidateSaved_ ? "Connected to saved network" : "Connected and saved";
      savedJoinPending_ = false;
      savedBeginPending_ = false;
      savedAttemptPassword_ = "";
      portalError_ = "";
      status_.joinFailures = 0;
      nextSavedIndex_ = 0;
      savedAttempts_ = 0;
      if (phone_.active) {
        phone_.phase = PhoneSetupPhase::Succeeded;
        phone_.waitingForHotspot = false;
        phoneHotspotDeadline_ = 0;
        phone_.candidateId = wifi_.candidateId;
        phone_.candidateResult = WifiCandidateResult::Succeeded;
        phone_.detail = "Connected and saved. Setup closes in ten seconds.";
        phoneFinishAt_ = millis() + 10000;
        ++phone_.revision;
      } else {
        stopPortal();
        WiFi.mode(WIFI_STA);
      }
      configPortal_ = false;
      status_.state = ProvisioningState::Online;
      knownGoodNetwork_ = true;
      status_.detail = WiFi.localIP().toString();
      justConnected_ = true;
      publishWifi(WifiConnectionPhase::Connected, "Connected; network saved");
      return;
    }
    if (millis() - portalJoinStartedAt_ >= kJoinTimeoutMs) {
      if (phone_.active && phone_.waitingForHotspot && phone_.candidateId == wifi_.candidateId
          && static_cast<int32_t>(millis() - phoneHotspotDeadline_) < 0) {
        // Retry the same validated candidate and receipt; never start a fresh user action.
        WiFi.disconnect(false, false, 0);
        portalJoinStartedAt_ = millis();
        candidateBeginPending_ = true;
      } else failWifiCandidate("Could not connect; previous networks kept");
    }
    return;
  }
  if (store_ && store_->hasWifiCredentials() && (!configPortal_ || WiFi.status() != WL_CONNECTED)) pollSavedJoin(true);
}

void Provisioning::handlePortalNotFound() {
  // Captive-portal detection probes (Apple's /hotspot-detect.html, Android's /generate_204) have to
  // be redirected, not 404'd, or the "Sign in to network" sheet never appears.
  server_.sendHeader("Location", status_.portalUrl, true);
  server_.send(302, "text/plain", "");
}
