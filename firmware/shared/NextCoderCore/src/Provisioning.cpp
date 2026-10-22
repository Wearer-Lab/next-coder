#include "Provisioning.h"

#include "GatewayDiscovery.h"
#include "GatewayTls.h"

namespace {
constexpr uint32_t kJoinTimeoutMs = 20000;
// After this many consecutive failures the stored network is presumed wrong and the portal comes
// back up. Three is enough to ride out a router still booting without stranding the owner.
constexpr uint8_t kMaxJoinFailures = 3;
// A unit left powered in a drawer must not sit as an open AP forever: the portal stands down, the
// last known network is retried, and the portal re-raises only if that fails again.
constexpr uint32_t kPortalIdleTimeoutMs = 15UL * 60UL * 1000UL;
constexpr uint32_t kScanCacheMs = 20000;
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
  portalJoinPending_ = false;
  portalRecoveryPending_ = false;
  pendingPassword_ = "";
  pendingSsid_ = "";
  pendingGateway_ = "";
  status_.state = ProvisioningState::Provisioning;
  status_.detail = keepStation ? "Reconfigure at " + apName_ : "Join " + apName_;

  // Reconfiguration keeps the station associated. That is what lets "Find gateway" in the portal
  // actually search: a device in pure SoftAP mode is not on the network it is being asked to
  // search, so the button could only ever time out.
  if (!keepStation && WiFi.getMode() != WIFI_OFF) {
    // Only tear down a station that exists. On a first boot with no stored credentials the Wi-Fi
    // driver has never been started, and disconnect() logs ESP_ERR_WIFI_NOT_INIT at error level --
    // alarming, and the very first thing an owner sees on the serial console of a new unit.
    WiFi.disconnect(true);
  }
  startPortal(keepStation);
}

void Provisioning::enterConnecting() {
  configPortal_ = false;
  portalJoinPending_ = false;
  portalRecoveryPending_ = false;
  stopPortal();
  status_.state = ProvisioningState::Connecting;
  status_.detail = store_->wifiSsid();
  connectStartedAt_ = millis();
  WiFi.mode(WIFI_STA);
  const auto settings = store_->transportSnapshot();
  WiFi.begin(settings.wifiSsid.c_str(), settings.wifiPassword.c_str());
  Serial.printf("[wifi] joining %s\n", store_->wifiSsid().c_str());
}

void Provisioning::resetToProvisioning() {
  if (store_ != nullptr) store_->resetForProvisioning();
  status_.joinFailures = 0;
  knownGoodNetwork_ = false;
  portalError_ = "";
  enterProvisioning();
}

void Provisioning::openConfigPortal() {
  status_.joinFailures = 0;
  portalError_ = "Update the gateway URL, then Save.";
  configPortal_ = store_ != nullptr && store_->hasWifiCredentials();
  enterProvisioning(configPortal_);
}

void Provisioning::closeConfigPortal() {
  if (!configPortal_) return;
  if (portalJoinPending_) {
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
  switch (status_.state) {
    case ProvisioningState::Unprovisioned:
      enterProvisioning();
      break;

    case ProvisioningState::Provisioning: {
      dns_.processNextRequest();
      server_.handleClient();
      pollPortalJoin();
      if (status_.state != ProvisioningState::Provisioning) break;
      // A liveness tick, so an idle portal is distinguishable from a wedged loop() on the bench.
      static uint32_t lastTickAt = 0;
      if (millis() - lastTickAt > 10000) {
        lastTickAt = millis();
        Serial.printf(
          "[wifi] portal alive ssid=%s clients=%u mode=%d ip=%s\n",
          apName_.c_str(),
          static_cast<unsigned>(WiFi.softAPgetStationNum()),
          static_cast<int>(WiFi.getMode()),
          WiFi.softAPIP().toString().c_str()
        );
      }
      const bool hadClient = WiFi.softAPgetStationNum() > 0;
      if (hadClient) portalLastClientAt_ = millis();
      if (portalLastClientAt_ == 0) portalLastClientAt_ = millis();
      if (store_->hasWifiCredentials() && millis() - portalLastClientAt_ > kPortalIdleTimeoutMs) {
        Serial.println("[wifi] portal idle; retrying the stored network");
        status_.joinFailures = 0;
        enterConnecting();
      }
      break;
    }

    case ProvisioningState::Connecting: {
      if (WiFi.status() == WL_CONNECTED) {
        status_.state = ProvisioningState::Online;
        knownGoodNetwork_ = true;
        status_.joinFailures = 0;
        status_.detail = WiFi.localIP().toString();
        justConnected_ = true;
        Serial.printf("[wifi] connected: %s\n", WiFi.localIP().toString().c_str());
        break;
      }
      // The timeout is the whole point: the previous firmware's `while (status != CONNECTED)` loop
      // made a wrong password unrecoverable without USB.
      if (millis() - connectStartedAt_ > kJoinTimeoutMs) {
        if (status_.joinFailures < UINT8_MAX) status_.joinFailures += 1;
        Serial.printf("[wifi] join failed (%u/%u)\n", status_.joinFailures, kMaxJoinFailures);
        if (!knownGoodNetwork_ && status_.joinFailures >= kMaxJoinFailures) {
          portalError_ = "Could not join " + store_->wifiSsid() + ". Check the password.";
          status_.detail = "Join failed";
          enterProvisioning();
        } else {
          enterConnecting();
        }
      }
      break;
    }

    case ProvisioningState::Online:
      // A drop is a return to Connecting, never a return to the portal: the credentials are known
      // good, so re-raising the AP on a router reboot would be actively unhelpful.
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[wifi] link lost; reconnecting");
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
  const bool apOk = WiFi.softAP(apName_.c_str());
  delay(100);
  const IPAddress ip = WiFi.softAPIP();
  Serial.printf(
    "[wifi] softAP mode=%d ap=%d ip=%s channel=%d\n",
    modeOk ? 1 : 0, apOk ? 1 : 0, ip.toString().c_str(), WiFi.channel()
  );
  if (!apOk) {
    status_.detail = "Radio failed";
    Serial.println("[wifi] softAP() refused; the portal is NOT broadcasting");
  }
  dns_.start(kDnsPort, "*", ip);

  // Routes are registered once for the lifetime of the object. WebServer::on() appends rather than
  // replaces, so re-registering on every retry would leak a handler per failed join attempt.
  if (!routesRegistered_) {
    server_.on("/", HTTP_GET, [this]() { handlePortalRoot(); });
    server_.on("/save", HTTP_POST, [this]() { handlePortalSubmit(); });
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

String Provisioning::scanOptionsHtml() {
  if (scanCache_.length() > 0 && millis() - scanCachedAt_ < kScanCacheMs) return scanCache_;

  String options;
  const int found = WiFi.scanNetworks();
  for (int i = 0; i < found; i += 1) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;
    options += "<option value=\"" + htmlEscape(ssid) + "\">" + htmlEscape(ssid)
      + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  WiFi.scanDelete();
  scanCache_ = options;
  scanCachedAt_ = millis();
  return scanCache_;
}

void Provisioning::handlePortalRoot() {
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
    "<select id=\"ssid\" name=\"ssid\">"
    // An empty first option is what makes a gateway-only save reachable: a <select> always submits
    // something, so without it there is no way to say "keep the network I already have".
    + String(store_->hasWifiCredentials()
        ? "<option value=\"\">Keep " + htmlEscape(store_->wifiSsid()) + "</option>"
        : "")
    + scanOptionsHtml() + "</select>"
    "<label for=\"password\">Password</label>"
    "<input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"off\">"
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
  portalLastClientAt_ = millis();

  if (portalJoinPending_) {
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

  if (ssid.length() == 0) {
    // A gateway-only correction. The owner reached this portal to fix a URL, and the stored
    // network is already known good — making them re-pick it and retype the password would be
    // asking for a second chance to get something wrong.
    if (gateway.length() > 0 && store_->hasWifiCredentials()) {
      if (!store_->setGatewayUrl(gateway)) {
        portalError_ = "Gateway URL was not saved.";
        handlePortalRoot();
        return;
      }
      Serial.printf("[wifi] gateway updated to %s; rejoining %s\n",
                    gateway.c_str(), store_->wifiSsid().c_str());
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
  pendingSsid_ = ssid;
  pendingPassword_ = password;
  pendingGateway_ = gateway;
  portalJoinPending_ = true;
  portalRecoveryPending_ = false;
  portalJoinStartedAt_ = millis();
  portalError_ = "Trying that network…";
  WiFi.mode(WIFI_AP_STA);
  WiFi.disconnect(false);
  WiFi.begin(pendingSsid_.c_str(), pendingPassword_.c_str());
}

void Provisioning::pollPortalJoin() {
  if (portalJoinPending_) {
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == pendingSsid_) {
      const bool saved = (pendingGateway_.length() == 0 || store_->setGatewayUrl(pendingGateway_))
          && store_->setWifiCredentials(pendingSsid_, pendingPassword_);
      pendingPassword_ = "";
      pendingSsid_ = "";
      pendingGateway_ = "";
      portalJoinPending_ = false;
      if (!saved) {
        portalError_ = "Network settings could not be saved. Please retry.";
        return;
      }
      portalError_ = "";
      status_.joinFailures = 0;
      stopPortal();
      WiFi.mode(WIFI_STA);
      status_.state = ProvisioningState::Online;
      knownGoodNetwork_ = true;
      status_.detail = WiFi.localIP().toString();
      justConnected_ = true;
      Serial.println("[wifi] provisioned and connected");
      return;
    }
    if (millis() - portalJoinStartedAt_ >= kJoinTimeoutMs) {
      portalError_ = "Could not join " + pendingSsid_ + ". Check the password and try again.";
      pendingPassword_ = "";
      pendingSsid_ = "";
      pendingGateway_ = "";
      portalJoinPending_ = false;
      WiFi.disconnect(false);
      nextPortalRecoveryAt_ = millis() + 30000;
    }
    return;
  }

  // A router may be offline at boot, before we can observe a known-good join. Keep the fallback
  // portal accessible while retrying stored credentials; recovery must not wait 15 idle minutes.
  if (configPortal_ || !store_ || !store_->hasWifiCredentials()) return;
  if (portalRecoveryPending_) {
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == store_->wifiSsid()) {
      portalRecoveryPending_ = false;
      stopPortal();
      WiFi.mode(WIFI_STA);
      status_.state = ProvisioningState::Online;
      knownGoodNetwork_ = true;
      status_.joinFailures = 0;
      status_.detail = WiFi.localIP().toString();
      justConnected_ = true;
    } else if (millis() - portalJoinStartedAt_ >= kJoinTimeoutMs) {
      portalRecoveryPending_ = false;
      nextPortalRecoveryAt_ = millis() + 30000;
    }
    return;
  }
  if ((int32_t)(millis() - nextPortalRecoveryAt_) < 0) return;
  WiFi.mode(WIFI_AP_STA);
  const auto settings = store_->transportSnapshot();
  WiFi.begin(settings.wifiSsid.c_str(), settings.wifiPassword.c_str());
  portalRecoveryPending_ = true;
  portalJoinStartedAt_ = millis();
}

void Provisioning::handlePortalNotFound() {
  // Captive-portal detection probes (Apple's /hotspot-detect.html, Android's /generate_204) have to
  // be redirected, not 404'd, or the "Sign in to network" sheet never appears.
  server_.sendHeader("Location", status_.portalUrl, true);
  server_.send(302, "text/plain", "");
}
