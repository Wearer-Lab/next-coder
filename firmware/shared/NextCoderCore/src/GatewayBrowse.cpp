#include "GatewayBrowse.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"
#include "GatewayHttp.h"
#include "GatewayWarm.h"
#include "GatewayDeviceRequest.h"
#include "OperateModel.h"

namespace {

String encodePathSegment(const String& value) {
  static const char* digits = "0123456789ABCDEF";
  String encoded;
  encoded.reserve(value.length());
  for (size_t i = 0; i < value.length(); i += 1) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += digits[(c >> 4) & 0x0F];
      encoded += digits[c & 0x0F];
    }
  }
  return encoded;
}

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

// Browsing runs off the render task and gets the ordinary cloud read budget. The decoded
// response is bounded before allocation for known and chunked lengths alike.
constexpr uint16_t kTimeoutMs = 6000;

}  // namespace

void GatewayBrowse::begin(DeviceStore& store) {
  store_ = &store;
  JsonDocument cached;
  if (!deserializeJson(cached, store.configCache())) {
    boundEnvironmentId_ = String(cached["config"]["environmentId"] | "");
    boundProjectId_ = String(cached["config"]["projectId"] | "");
  }
}

bool GatewayBrowse::refreshAgents() {
  agentCount_ = 0; agentDetail_ = "";
  String response;
  const int code = request("GET", "/v1/device/runtimes", "", response);
  JsonDocument doc;
  if (!ok(code) || deserializeJson(doc, response)) { agentDetail_ = "Agents unavailable; retry"; touch(); return false; }
  directAgentsSupported_ = doc["supported"] | false;
  for (JsonObject row : doc["runtimes"].as<JsonArray>()) {
    if (agentCount_ >= 12) break;
    BrowseAgent& item = agents_[agentCount_++]; item = BrowseAgent();
    item.runtimeId = String(row["runtimeId"] | ""); item.model = String(row["model"] | "");
    item.row.id = item.runtimeId + ":" + item.model; item.row.title = String(row["label"] | "Agent");
    item.row.status = "NEXT TURN";
  }
  agentDetail_ = !directAgentsSupported_ ? "T3 manages this environment" : (doc["truncated"] | false) ? "More agents in dashboard" : "Choose an agent and model";
  touch(); return true;
}

bool GatewayBrowse::refreshNativeSessions(const String& runtimeId, const String& model) {
  agentCount_ = 0;
  String response;
  const String path = "/v1/device/sessions?runtimeId=" + encodePathSegment(runtimeId);
  const int code = request("GET", path.c_str(), "", response);
  JsonDocument doc;
  if (!ok(code) || deserializeJson(doc, response)) { agentDetail_ = "Session discovery unavailable"; touch(); return false; }
  for (JsonObject row : doc["sessions"].as<JsonArray>()) {
    if (agentCount_ >= 12) break;
    BrowseAgent& item = agents_[agentCount_++]; item = BrowseAgent();
    item.runtimeId = runtimeId; item.model = model; item.nativeSessionId = String(row["id"] | "");
    item.resumable = String(row["attachment"] | "") == "resume";
    item.row.id = item.nativeSessionId; item.row.title = String(row["title"] | "Saved session");
    item.row.status = item.resumable ? "SAVED; STOP OTHER APP FIRST" : "VIEW ONLY";
  }
  agentDetail_ = (doc["truncated"] | false) || !doc["nextCursor"].isNull() ? "More sessions in dashboard" : agentCount_ ? "Stop other app before resume" : "No saved sessions";
  touch(); return true;
}

bool GatewayBrowse::postAgentIntent(const String& intentJson, const String& threadId, String& resultThreadId) {
  if (!store_) return false;
  JsonDocument doc, intent;
  if (deserializeJson(intent, intentJson)) return false;
  doc["intent"] = intent.as<JsonObject>();
  doc["expectedEnvironmentId"] = boundEnvironmentId_;
  doc["expectedProjectId"] = boundProjectId_;
  if (threadId.length()) doc["expectedThreadId"] = threadId;
  else doc["expectedThreadId"] = nullptr;
  String failure;
  const String requestId = gateway_request::beginDurableDeviceRequest(store_, boundEnvironmentId_ + "\n" + threadId + "\n" + intentJson,
    [this](const String& id) { return gateway_request::resolveDurableDeviceReceipt(id,
      [this](const char* path, String& result) { return request("GET", path, "", result); }); }, failure);
  if (!requestId.length()) { agentDetail_ = failure; return false; }
  doc["clientRequestId"] = requestId;
  doc["threadId"] = threadId.length() ? threadId : "native-import";
  String body, response; serializeJson(doc, body);
  const int code = request("POST", "/v1/device/intents", body, response);
  gateway_request::settleDurableDeviceRequest(store_, requestId, code, response);
  JsonDocument result;
  if (!ok(code) || deserializeJson(result, response) || String(result["command"]["status"] | "") != "completed") {
    agentDetail_ = String(result["command"]["status"] | "") == "approval_required" ? "Gateway approval in dashboard"
      : code == 403 ? "Not allowed by device profile" : "Not confirmed; check status"; return false;
  }
  resultThreadId = String(result["command"]["result"]["threadId"] | "");
  return resultThreadId.length() > 0;
}

bool GatewayBrowse::useAgent(size_t index, const String& threadId) {
  const BrowseAgent* row = agent(index); if (!row || !threadId.length()) return false;
  JsonDocument intent;
  intent["type"] = "runtime_switch"; intent["runtimeId"] = row->runtimeId; intent["model"] = row->model;
  String json, result; serializeJson(intent, json);
  const bool applied = postAgentIntent(json, threadId, result);
  if (applied) agentDetail_ = "Agent selected for next turn";
  touch(); return applied;
}

bool GatewayBrowse::resumeNativeSession(size_t index, const String& threadId) {
  const BrowseAgent* row = agent(index); if (!row || !row->resumable) return false;
  JsonDocument intent;
  intent["type"] = "runtime_import"; intent["runtimeId"] = row->runtimeId; intent["model"] = row->model;
  intent["nativeSessionId"] = row->nativeSessionId; intent["projectId"] = boundProjectId_; intent["confirmResume"] = true;
  String json, result; serializeJson(intent, json);
  if (!postAgentIntent(json, threadId, result)) { touch(); return false; }
  // Import and destination selection have separate receipts. A failed selection leaves the
  // imported conversation discoverable and keeps the prior destination authoritative.
  beginPreview(boundEnvironmentId_, boundProjectId_);
  if (!refreshPreviewThreads()) return false;
  for (size_t i = 0; i < previewThreadCount_; ++i) if (previewThreads_[i].id == result) {
    const bool applied = commitPreviewThread(i);
    if (applied) { created_ = BrowseThread(); created_.id = result; created_.title = previewThreads_[i].title; created_.selected = true; agentDetail_ = "Saved session selected"; }
    touch(); return applied;
  }
  agentDetail_ = "Imported; select in dashboard"; touch(); return false;
}

int GatewayBrowse::request(const char* method, const char* path, const String& body,
                           String& response) {
  if (!store_) return -1;
  if (WiFi.status() != WL_CONNECTED) return -1;
  const auto settings = store_->transportSnapshot();
  const String base = settings.gatewayUrl;
  if (base.length() == 0) return -1;

  const String url = base + path;

  // All board routes share one bounded TLS allocation gate and the one warm foreground session
  // (GatewayWarm.h), so a browse read right after a gateway poll reuses its connection instead of
  // closing it and paying a handshake of its own. The gate outlives HTTP/socket use on every path.
  const uint32_t gateWaitStart = millis();
  if (!gateway_tls::lockTlsKeepWarm()) return -1;
  struct TlsGuard { ~TlsGuard() { gateway_tls::unlockTls(); } } tlsGuard;
  long retryAfter = 1;   // browse does not back off on 429; the caller shows the remedy
  return gateway_warm::exchange("browse", method, path, url, settings.deviceId, settings.deviceSecret,
                                body, response, retryAfter, kTimeoutMs, kTimeoutMs,
                                millis() - gateWaitStart);
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
    if (environments_[i].id == (previewActive_ ? previewEnvironmentId_ : boundEnvironmentId_) && environments_[i].label.length() > 0) {
      return environments_[i].label;
    }
  }
  return String();
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

bool GatewayBrowse::refreshProjects() {
  if (!previewActive_) {
    projectCount_ = 0;
    selectedProjectIndex_ = -1;
    projectsTruncated_ = false;
  }
  projectsDetail_ = "";

  String response;
  const String path = previewActive_
    ? String("/v1/device/projects?environmentId=") + encodePathSegment(previewEnvironmentId_)
    : String("/v1/device/projects");
  const int code = request("GET", path.c_str(), "", response);
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
  if (previewActive_ && (String(doc["destinationSelection"] | "") != "atomic-v1"
      || env != previewEnvironmentId_ || !doc["projects"].is<JsonArray>())) {
    previewContractReady_ = false;
    projectsDetail_ = "Update gateway; destination unavailable";
    touch();
    return false;
  }
  projectCount_ = 0;
  selectedProjectIndex_ = -1;
  projectsTruncated_ = false;
  if (!previewActive_) {
    if (env.length() > 0) boundEnvironmentId_ = env;
    boundProjectId_ = String(doc["projectId"] | "");
  }

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
    if (projects_[i].id == (previewActive_ ? previewProjectId_ : boundProjectId_) && projects_[i].title.length() > 0) {
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
      if (detailCode == "device_context_changed") return "Context changed; reload folders";
      if (detailCode == "idempotency_conflict") return "Check console; previous request";
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
  if (previewActive_ && !previewContractReady_) {
    createDetail_ = "Refresh destination before creating";
    touch();
    return false;
  }

  JsonDocument bodyDoc;
  if (!previewActive_) {
    if (boundEnvironmentId_.length()) bodyDoc["expectedEnvironmentId"] = boundEnvironmentId_;
    else bodyDoc["expectedEnvironmentId"] = nullptr;
    if (boundProjectId_.length()) bodyDoc["expectedProjectId"] = boundProjectId_;
    else bodyDoc["expectedProjectId"] = nullptr;
  }
  if (previewActive_) {
    bodyDoc["destinationSelection"] = "atomic-v1";
    bodyDoc["environmentId"] = previewEnvironmentId_;
    bodyDoc["projectId"] = previewProjectId_;
  }
  if (title.length() > 0) bodyDoc["title"] = title;
  String requestFailure;
  const String requestId = gateway_request::beginDurableDeviceRequest(
    store_, String("thread-create\n") + (previewActive_ ? previewEnvironmentId_ : boundEnvironmentId_) + "\n" + (previewActive_ ? previewProjectId_ : boundProjectId_) + "\n" + title,
    [this](const String& id) { return gateway_request::resolveDurableDeviceReceipt(id,
      [this](const char* path, String& result) { return request("GET", path, "", result); }); }, requestFailure
  );
  if (requestId.length() == 0) {
    createDetail_ = requestFailure;
    createStatus_ = 507;
    touch();
    return false;
  }
  bodyDoc["clientRequestId"] = requestId;
  String body;
  serializeJson(bodyDoc, body);

  String response;
  const int code = request("POST", "/v1/device/threads", body, response);
  createStatus_ = code;
  if (!ok(code)) {
    gateway_request::settleDurableDeviceRequest(store_, requestId, code, response);
    createDetail_ = code <= 0 ? String("Not confirmed; retry New thread") : createRemedy(code, response);
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
  const String targetEnvironment = previewActive_ ? previewEnvironmentId_ : boundEnvironmentId_;
  const String targetProject = previewActive_ ? previewProjectId_ : boundProjectId_;
  if (String(doc["config"]["threadId"] | "") != created_.id
      || String(doc["config"]["environmentId"] | "") != targetEnvironment
      || String(doc["config"]["projectId"] | "") != targetProject) {
    created_ = BrowseThread();
    createDetail_ = "Created; refresh destination in console";
    touch();
    return false;
  }
  gateway_request::settleDurableDeviceRequest(store_, requestId, code, response);
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


void GatewayBrowse::beginPreview(const String& environmentId, const String& projectId) {
  previewActive_ = true;
  previewContractReady_ = false;
  // The caller supplies the currently confirmed binding, rather than an old boot-time cache.
  boundEnvironmentId_ = environmentId;
  boundProjectId_ = projectId;
  previewEnvironmentId_ = environmentId;
  previewProjectId_ = projectId;
  previewThreadCount_ = 0;
  previewDetail_ = "";
}

bool GatewayBrowse::previewEnvironment(size_t index) {
  const BrowseEnvironment* row = environment(index);
  if (!row) return false;
  previewActive_ = true;
  previewContractReady_ = false;
  previewEnvironmentId_ = row->id;
  previewProjectId_ = "";
  previewThreadCount_ = 0;
  projectCount_ = 0;
  touch();
  return true;
}

bool GatewayBrowse::previewProject(size_t index) {
  const BrowseProject* row = project(index);
  if (!row) return false;
  previewContractReady_ = false;
  previewProjectId_ = row->id;
  previewThreadCount_ = 0;
  touch();
  return true;
}

bool GatewayBrowse::refreshPreviewThreads() {
  // A list that was already held (seedPreviewThreads) stays committable across a revalidation that
  // merely FAILED to reach the gateway: the contract it was proved under has not changed, the rows
  // are still on screen, and the commit is validated server-side anyway. Closing the gate on a
  // dropped packet would turn "check this behind the list" into "the list stops working". A reply
  // that arrives and breaks the contract (old gateway, wrong destination) closes it below.
  const bool wasReady = previewContractReady_;
  previewContractReady_ = false;
  String response;
  const String path = String("/v1/device/threads?environmentId=")
    + encodePathSegment(previewEnvironmentId_) + "&projectId=" + encodePathSegment(previewProjectId_);
  const int code = request("GET", path.c_str(), "", response);
  if (!ok(code)) { previewContractReady_ = wasReady; previewDetail_ = remedyFor(code); touch(); return false; }
  JsonDocument doc;
  if (deserializeJson(doc, response)) { previewContractReady_ = wasReady; previewDetail_ = "Bad thread JSON"; touch(); return false; }
  if (String(doc["destinationSelection"] | "") != "atomic-v1"
      || String(doc["environmentId"] | "") != previewEnvironmentId_
      || String(doc["projectId"] | "") != previewProjectId_
      || !doc["threads"].is<JsonArray>()) {
    previewDetail_ = "Update gateway; destination unavailable";
    touch();
    return false;
  }
  previewContractReady_ = true;
  previewThreadCount_ = 0;
  previewDetail_ = "";
  for (JsonObject input : doc["threads"].as<JsonArray>()) {
    if (previewThreadCount_ >= kMaxThreadOptions) { previewDetail_ = "More in console"; break; }
    const String id = String(input["id"] | "");
    if (!id.length()) continue;
    ThreadOption& row = previewThreads_[previewThreadCount_++];
    row = ThreadOption();
    row.id = id;
    row.title = String(input["title"] | "Untitled thread");
    row.status = String(input["status"] | "");
    row.status.toUpperCase();
    row.selected = input["selected"] | false;
  }
  if (!previewThreadCount_) previewDetail_ = "No threads; create one below";
  touch();
  return true;
}

bool GatewayBrowse::commitPreviewThread(size_t index) {
  if (!previewActive_ || !previewContractReady_) {
    previewDetail_ = "Refresh destination before selecting";
    touch();
    return false;
  }
  const ThreadOption* row = previewThread(index);
  if (!row) return false;
  JsonDocument doc;
  doc["destinationSelection"] = "atomic-v1";
  doc["environmentId"] = previewEnvironmentId_;
  doc["projectId"] = previewProjectId_;
  doc["threadId"] = row->id;
  String body, response;
  serializeJson(doc, body);
  const int code = request("POST", "/v1/device/config/thread", body, response);
  if (!ok(code)) { previewDetail_ = code <= 0 ? "Not confirmed; refresh then retry" : remedyFor(code); touch(); return false; }
  // Do not adopt an unparseable success as a new local destination.
  JsonDocument result;
  if (deserializeJson(result, response)
      || String(result["config"]["threadId"] | "") != row->id
      || String(result["config"]["environmentId"] | "") != previewEnvironmentId_
      || String(result["config"]["projectId"] | "") != previewProjectId_) {
    previewDetail_ = "Not confirmed; refresh then retry"; touch(); return false;
  }
  boundEnvironmentId_ = previewEnvironmentId_;
  boundProjectId_ = previewProjectId_;
  previewDetail_ = "";
  touch();
  return true;
}
