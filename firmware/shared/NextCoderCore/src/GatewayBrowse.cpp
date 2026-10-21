#include "GatewayBrowse.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"
#include "OperateModel.h"

namespace {

bool ok(int code) { return code >= 200 && code < 300; }

// The same one-line remedies GatewayOperate.cpp gives a person standing at the device. Duplicated
// rather than shared because the alternative is exporting a private helper out of that file, and a
// browse screen has two codes of its own that the thread list never sees.
String remedyFor(int code) {
  switch (code) {
    case 400: return "Gateway rejected the id";
    case 401:
    case 403: return "Re-pair T3 in dashboard";
    case 404: return "Gone; reload the list";
    case 409: return "No environment set";
    case 429: return "Rate limited; wait";
    case 500:
    case 502: return "Start T3 Code";
    default:  return code > 0 ? String("HTTP ") + code : String("No response");
  }
}

// Longer than GatewayClient's 1200 ms, and the difference is deliberate. That budget bounds a
// worst-case render stall for calls that happen on a timer; these happen when somebody has just
// pressed something and is waiting to find out what is in the list. Both project routes also go
// all the way to the T3 host for a live snapshot, which a heartbeat never does.
//
// The response body is bounded by kMaxResponseBodyBytes from OperateModel.h, checked before the
// body is read into a String — which is the only point at which refusing it still saves the heap.
constexpr uint16_t kTimeoutMs = 2000;

}  // namespace

void GatewayBrowse::begin(DeviceStore& store) { store_ = &store; }

int GatewayBrowse::request(const char* method, const char* path, const String& body,
                           String& response) {
  if (!store_) return -1;
  if (WiFi.status() != WL_CONNECTED) return -1;
  const String base = store_->gatewayUrl();
  if (base.length() == 0) return -1;

  const String url = base + path;

  // Declaration order is load-bearing, exactly as in GatewayClient::request(): C++ destroys locals
  // in reverse order, HTTPClient holds a reference to the client it was handed, and an HTTPClient
  // declared first is destroyed last — calling stop() through a dead vtable. Clients first.
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  if (!gateway_tls::beginHttp(http, plain, secure, url, "browse")) return -1;

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());

  const int code = String(method) == "POST" ? http.POST(body) : http.GET();
  if (code > 0) {
    const int length = http.getSize();
    if (length > (int)kMaxResponseBodyBytes) {
      Serial.printf("[browse] %s oversized response %d bytes\n", path, length);
      response = "response too large";
    } else {
      response = http.getString();
    }
  } else {
    Serial.printf("[browse] %s failed code=%d\n", path, code);
  }

  http.end();
  return code;
}

const BrowseEnvironment* GatewayBrowse::environment(size_t index) const {
  return index < environmentCount_ ? &environments_[index] : nullptr;
}

const BrowseProject* GatewayBrowse::project(size_t index) const {
  return index < projectCount_ ? &projects_[index] : nullptr;
}

bool GatewayBrowse::consumeContextCleared() {
  const bool value = contextCleared_;
  contextCleared_ = false;
  return value;
}

String browseEnvironmentAction(const BrowseEnvironment& row) {
  if (row.action.length() > 0) return row.action;
  if (row.tokenExpired) return "RE-PAIR T3";
  if (row.transport == "connector") {
    if (row.connectorStatus == "revoked") return "RE-PAIR CONNECTOR";
    if (row.connectorStatus == "incompatible") return "UPDATE CONNECTOR";
    if (row.connectorStatus == "sleeping") return "WAKE COMPUTER";
    if (row.connectorStatus == "unknown" || row.connectorStatus == "enrolled"
        || row.connectorStatus == "waiting" || row.connectorStatus == "offline") {
      return "START CONNECTOR";
    }
    if (row.connectorStatus == "reconnecting") return "CHECK CONNECTION";
  }
  if (row.t3Status == "auth_failed") return "FIX T3 AUTH";
  if (row.t3Status == "stopped") return "START T3 CODE";
  if (row.t3Status == "incompatible") return "UPDATE T3 CODE";
  if (row.t3Status == "starting") return "T3 STARTING";
  if (row.t3Status == "error") return "CHECK T3 CODE";
  if (row.providerStatus == "auth_required") return "AUTH PROVIDER";
  if (row.providerStatus == "model_unavailable") return "ADD PROVIDER MODEL";
  if (row.providerStatus == "error") return "CHECK PROVIDER";
  if (row.freshness == "stale") return "CHECK CONNECTION";
  if (row.t3Status == "ready" && row.providerStatus == "ready") return "READY";
  if (row.status.length() > 0 && row.status != "UNKNOWN") return row.status;
  return "CHECK STATUS";
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

bool GatewayBrowse::refreshEnvironments() {
  environmentCount_ = 0;
  selectedEnvironmentIndex_ = -1;
  environmentsTruncated_ = false;
  environmentsDetail_ = "";

  String response;
  const int code = request("GET", "/v1/device/environments", "", response);
  if (!ok(code)) {
    environmentsDetail_ = remedyFor(code);
    touch();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    environmentsDetail_ = "Bad environment JSON";
    touch();
    return false;
  }

  // The gateway names what is bound; the per-row flag duplicates it for simple renderers, and this
  // one trusts either. A device never invents a binding it was not told about.
  boundEnvironmentId_ = String(doc["environmentId"] | "");
  environmentsTruncated_ = doc["environmentsTruncated"] | false;
  JsonArray rows = doc["environments"].as<JsonArray>();
  for (JsonObject input : rows) {
    // Bounds-checked against environments_, which is the array being written. The cap and the loop
    // guard are the same number on purpose.
    if (environmentCount_ >= kMaxBrowseEnvironments) {
      environmentsTruncated_ = true;
      break;
    }
    const String id = String(input["id"] | "");
    if (id.length() == 0) continue;
    BrowseEnvironment& row = environments_[environmentCount_];
    row = BrowseEnvironment();
    row.id = id;
    row.label = String(input["label"] | "Untitled environment");
    row.status = String(input["status"] | "");
    row.status.toUpperCase();
    row.tokenExpired = input["tokenExpired"] | false;
    row.selected = (input["selected"] | false) || id == boundEnvironmentId_;
    JsonObject health = input["health"].as<JsonObject>();
    row.transport = String(health["transport"] | "direct");
    row.freshness = String(health["freshness"] | "unknown");
    row.connectorStatus = String(health["connector"] | "not_applicable");
    row.t3Status = String(health["t3"] | "unknown");
    row.providerStatus = String(health["provider"] | "unknown");
    row.observedAt = String(health["observedAt"] | "");
    row.action = String(health["action"] | "");
    if (row.action.length() > 24) row.action = "CHECK STATUS";
    row.action.toUpperCase();
    if (row.selected) selectedEnvironmentIndex_ = (int)environmentCount_;
    environmentCount_ += 1;
  }

  if (environmentCount_ == 0) environmentsDetail_ = "No environments; pair T3";
  else if (environmentsTruncated_) environmentsDetail_ = "More in the console";
  touch();
  return environmentCount_ > 0;
}

bool GatewayBrowse::selectEnvironment(size_t index) {
  if (index >= environmentCount_) return false;
  BrowseEnvironment& target = environments_[index];

  // Re-binding the environment already in place is defined server-side to keep the project and
  // thread, so the round trip would change nothing at all. Skip it.
  if (target.selected && target.id == boundEnvironmentId_) {
    selectedEnvironmentIndex_ = (int)index;
    return true;
  }

  JsonDocument doc;
  doc["environmentId"] = target.id;
  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/config/environment", body, response);
  if (!ok(code)) {
    environmentsDetail_ = remedyFor(code);
    touch();
    return false;
  }

  boundEnvironmentId_ = target.id;
  for (size_t i = 0; i < environmentCount_; i += 1) environments_[i].selected = false;
  target.selected = true;
  selectedEnvironmentIndex_ = (int)index;
  environmentsDetail_ = "";

  // Moving environment clears projectId and threadId server-side, because those ids only meant
  // something inside the environment being left. Holding on to the old lists here would show the
  // owner a folder that no longer exists and a thread that no longer drives anything.
  projectCount_ = 0;
  selectedProjectIndex_ = -1;
  projectsDetail_ = "";
  boundProjectId_ = "";
  contextCleared_ = true;
  touch();
  return true;
}

// A NAME or nothing. Never the id.
//
// This used to fall back to a shortened id on the theory that it was still a stable handle somebody
// could match in the console. On glass that meant `jn72kshfoxn642tdlhsjspv1e58o34` across the top
// of the thread list, which identifies the environment to the gateway and to nobody standing in
// front of the device. An empty string lets the caller say "Environment" and go and fetch the list,
// which is the answer a person can act on.
String GatewayBrowse::environmentLabel() const {
  for (size_t i = 0; i < environmentCount_; i += 1) {
    if (environments_[i].id == boundEnvironmentId_ && environments_[i].label.length() > 0) {
      return environments_[i].label;
    }
  }
  return String();
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

bool GatewayBrowse::refreshProjects() {
  projectCount_ = 0;
  selectedProjectIndex_ = -1;
  projectsTruncated_ = false;
  projectsDetail_ = "";

  String response;
  const int code = request("GET", "/v1/device/projects", "", response);
  if (!ok(code)) {
    projectsDetail_ = remedyFor(code);
    touch();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    projectsDetail_ = "Bad project JSON";
    touch();
    return false;
  }

  // The projects route answers with the environment it resolved against, which is the authoritative
  // answer to "which host am I looking at" even when the environment list has never been fetched.
  const String env = String(doc["environmentId"] | "");
  if (env.length() > 0) boundEnvironmentId_ = env;
  boundProjectId_ = String(doc["projectId"] | "");

  JsonArray rows = doc["projects"].as<JsonArray>();
  for (JsonObject input : rows) {
    if (projectCount_ >= kMaxBrowseProjects) {
      projectsTruncated_ = true;
      break;
    }
    const String id = String(input["id"] | "");
    if (id.length() == 0) continue;
    BrowseProject& row = projects_[projectCount_];
    row = BrowseProject();
    row.id = id;
    row.title = String(input["title"] | "Untitled folder");
    row.threadCount = input["threadCount"] | 0;
    row.selected = (input["selected"] | false) || id == boundProjectId_;
    if (row.selected) selectedProjectIndex_ = (int)projectCount_;
    projectCount_ += 1;
  }

  if (projectCount_ == 0) projectsDetail_ = "No folders in this env";
  else if (projectsTruncated_) projectsDetail_ = "More in the console";
  touch();
  return projectCount_ > 0;
}

bool GatewayBrowse::selectProject(size_t index) {
  if (index >= projectCount_) return false;
  BrowseProject& target = projects_[index];

  if (target.selected && target.id == boundProjectId_) {
    selectedProjectIndex_ = (int)index;
    return true;
  }

  JsonDocument doc;
  doc["projectId"] = target.id;
  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/config/project", body, response);
  if (!ok(code)) {
    projectsDetail_ = remedyFor(code);
    touch();
    return false;
  }

  boundProjectId_ = target.id;
  for (size_t i = 0; i < projectCount_; i += 1) projects_[i].selected = false;
  target.selected = true;
  selectedProjectIndex_ = (int)index;
  projectsDetail_ = "";

  // Choosing a folder that does not contain the current thread clears threadId server-side. Which
  // of the two happened is not reported in the response body, so the caller re-reads the thread
  // list either way — a stale thread label over a cleared selection is the one lie this screen
  // could tell that would matter.
  contextCleared_ = true;
  touch();
  return true;
}

String GatewayBrowse::projectLabel() const {
  for (size_t i = 0; i < projectCount_; i += 1) {
    if (projects_[i].id == boundProjectId_ && projects_[i].title.length() > 0) {
      return projects_[i].title;
    }
  }
  // Nothing bound means "the whole environment", which is the documented default and is a real
  // answer — but only once the list has actually been asked for. Before that this device does not
  // know whether a folder is bound or not, and a breadcrumb reading "All folders" over a device
  // that is in fact scoped to one would be the screen inventing a fact it was never told.
  if (boundProjectId_.length() == 0) {
    return projectCount_ > 0 ? String("All folders") : String();
  }
  // Same rule as environmentLabel(): a folder the fetched list does not name is not worth naming
  // with its id.
  return String();
}

// ---------------------------------------------------------------------------------------------
// Creating a thread
// ---------------------------------------------------------------------------------------------

// Turns a refused create into the one line the protocol doc's error table specifies.
//
// Every one of these leaves the device on the thread it was already on — a refused create changes
// nothing — so each says what happened and none of them implies anything was created.
static String createRemedy(int code, const String& body) {
  JsonDocument doc;
  String detailCode;
  String dimension;
  if (body.length() > 0 && !deserializeJson(doc, body)) {
    detailCode = String(doc["error"]["details"]["code"] | "");
    dimension = String(doc["error"]["details"]["policy"]["dimension"] | "");
  }

  switch (code) {
    case 403:
      // A read-only profile, or a user/environment/network/time-window rule. The dimension names
      // which, and it is worth showing: "profile" is a different fix from "network".
      return dimension.length() > 0 ? String("Not allowed: ") + dimension
                                    : String("Not allowed on this device");
    case 404:
      return "Folder is gone; pick another";
    case 409:
      if (detailCode == "no_model_selection") return "No model configured for this folder";
      return "Pick a folder first";
    case 502:
      return detailCode == "t3_unreachable" ? String("Start T3 Code") : String("Create failed");
    case 429:
      return "Rate limited; wait";
    default:
      return code > 0 ? String("Create failed ") + code : String("No response");
  }
}

bool GatewayBrowse::createThread(const String& title) {
  created_ = BrowseThread();
  createDetail_ = "";
  createStatus_ = 0;

  // An empty body is a complete request. The device names neither the project nor the environment:
  // the thread is always created in the config the owner bound, and every id in the answer is one
  // the gateway chose.
  String body = "{}";
  if (title.length() > 0) {
    JsonDocument doc;
    doc["title"] = title;
    body = "";
    serializeJson(doc, body);
  }

  String response;
  const int code = request("POST", "/v1/device/threads", body, response);
  createStatus_ = code;
  if (!ok(code)) {
    createDetail_ = createRemedy(code, response);
    touch();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    createDetail_ = "Bad create JSON";
    touch();
    return false;
  }

  JsonObject thread = doc["thread"];
  created_.id = String(thread["id"] | doc["threadId"] | "");
  if (created_.id.length() == 0) {
    createDetail_ = "Gateway named no thread";
    touch();
    return false;
  }
  created_.title = String(thread["title"] | "New thread");
  created_.status = String(thread["status"] | "idle");
  created_.selected = true;

  // The create also bound it, and `config` is the device's updated config. Recording it here keeps
  // the breadcrumb honest without a second round trip.
  JsonObject config = doc["config"];
  const String env = String(config["environmentId"] | "");
  const String project = String(config["projectId"] | "");
  if (env.length() > 0) boundEnvironmentId_ = env;
  if (project.length() > 0) boundProjectId_ = project;

  Serial.printf("[browse] created thread %s\n", created_.id.c_str());
  touch();
  return true;
}
