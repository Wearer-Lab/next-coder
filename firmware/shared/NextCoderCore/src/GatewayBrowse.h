#pragma once

// The two levels above a thread: which paired T3 host, and which folder inside it.
//
// `GET /v1/device/threads` used to be the whole picker the device protocol offered, and the
// firmware said so in three places. It is not any more — the gateway grew
// `/v1/device/environments` and `/v1/device/projects` with matching `POST /v1/device/config/*`
// endpoints (docs/hardware-protocol.md, "Environment, project, and thread API"), and a controller
// that cannot reach them can only ever drive the one environment its owner bound in the console.
//
// This lives in its own translation unit with its own state rather than as members on
// GatewayClient, so the class every board already depends on does not grow a new surface while it
// is being worked on elsewhere. The cost is one duplicated request helper; the benefit is that
// nothing else has to change to gain a browser.
//
// Same contract as GatewayClient's gesture calls, and it matters more here because there is no
// polling to hide behind: each call below performs exactly ONE blocking HTTP request and returns
// when it is done. Call on a network worker, publish its staged result on the UI task.

#include <Arduino.h>

#include "DeviceStore.h"
#include "OperateModel.h"

// An owner rarely has more than a couple of paired hosts, and the screen shows five rows. A
// longer list is truncated and said to be truncated, never silently clipped.
constexpr size_t kMaxBrowseEnvironments = 8;

// Folders inside one environment. The same cap as the thread list, for the same reason: this is
// browsed a page at a time, not displayed whole.
constexpr size_t kMaxBrowseProjects = 12;

// The compact, non-secret row `deviceSelectableEnvironments()` publishes. These are facts and one
// bounded action label, not the environment record: URLs, errors, provider names/models, scopes,
// pairing state, and credentials stay out of the device realm.
struct BrowseEnvironment {
  String id;
  String label;
  String status;        // upper-cased, for display
  bool tokenExpired = false;
  bool selected = false;
  String transport;
  String freshness;
  String connectorStatus;
  String t3Status;
  String providerStatus;
  String observedAt;
  String action;
};

// One deterministic line for a constrained display. New gateways send `health.action`; the
// fallback keeps controllers useful while talking to an older gateway or a partially populated
// projection, using the same connector -> T3 -> provider -> freshness priority.
String browseEnvironmentAction(const BrowseEnvironment& row);

// `threadCount` is the field that makes this list usable at arm's length: it says which folder has
// anything in it before somebody pages into an empty one.
// A row of GET /v1/device/threads, which is also exactly what POST /v1/device/threads answers with.
struct BrowseThread {
  String id;
  String title;
  String status;
  bool selected = false;
};

struct BrowseProject {
  String id;
  String title;
  int threadCount = 0;
  bool selected = false;
};

struct BrowseAgent {
  ThreadOption row;
  String runtimeId;
  String model;
  String nativeSessionId;
  bool resumable = false;
};

class GatewayBrowse {
 public:
  void begin(DeviceStore& store);
  // Direct runtimes use the same cloud policy, receipts and selected destination as T3.
  // These blocking calls belong on the network worker, never the render task.
  bool refreshAgents();
  bool refreshNativeSessions(const String& runtimeId, const String& model);
  bool useAgent(size_t index, const String& threadId);
  bool resumeNativeSession(size_t index, const String& threadId);
  size_t agentCount() const { return agentCount_; }
  const BrowseAgent* agent(size_t index) const { return index < agentCount_ ? &agents_[index] : nullptr; }
  const String& agentDetail() const { return agentDetail_; }
  bool directAgentsSupported() const { return directAgentsSupported_; }

  // Environments. Answers 200 even with nothing bound — a controller with no environment is
  // exactly the one that needs the list.
  bool refreshEnvironments();
  size_t environmentCount() const { return environmentCount_; }
  const BrowseEnvironment* environment(size_t index) const;
  int selectedEnvironmentIndex() const { return selectedEnvironmentIndex_; }
  const String& environmentsDetail() const { return environmentsDetail_; }
  bool environmentsTruncated() const { return environmentsTruncated_; }

  // Binds one. Returns true only on a confirmed 2xx: the local list's `selected` marker moves
  // after the gateway agrees, never in anticipation of it.
  bool selectEnvironment(size_t index);

  // Projects inside the bound environment. 409 with no environment bound and 502 when the T3 host
  // cannot be reached; both arrive as a one-line remedy in projectsDetail().
  bool refreshProjects();

  // Preview navigation is read-only. Only commitPreviewThread/createThread changes
  // the destination, in one server-confirmed write. Legacy select* stays compatible.
  void beginPreview(const String& environmentId, const String& projectId);

  // Local-first entry: fills the preview list from rows the caller ALREADY HOLDS for exactly this
  // environment and folder, so the screen paints at once and refreshPreviewThreads() only has to
  // confirm it. `rowAt(i)` yields the i-th held row (or null).
  //
  // The caller owns the proof that the rows belong to this destination (GatewayClient::
  // threadListMatches(): the gateway stamped them with this environment and project under the
  // atomic-v1 contract). That is why the commit gate may open here without a fetch: the contract
  // check refreshPreviewThreads() performs has already happened for these very rows. Committing is
  // still one server write, validated against T3's live snapshot, so a thread that vanished since
  // is refused with a 404 and nothing is bound locally until the gateway confirms.
  //
  // Call after beginPreview() or previewProject()/previewEnvironment(); it replaces the list.
  template <typename RowAt>
  void seedPreviewThreads(size_t count, RowAt&& rowAt) {
    previewThreadCount_ = 0;
    for (size_t i = 0; i < count && previewThreadCount_ < kMaxThreadOptions; ++i) {
      const ThreadOption* row = rowAt(i);
      if (!row || row->id.length() == 0) continue;
      previewThreads_[previewThreadCount_++] = *row;
    }
    previewContractReady_ = true;
    previewDetail_ = previewThreadCount_ ? String() : String("No threads; create one below");
    touch();
  }
  bool previewEnvironment(size_t index);
  bool previewProject(size_t index);
  bool refreshPreviewThreads();
  bool commitPreviewThread(size_t index);
  const String& previewEnvironmentId() const { return previewEnvironmentId_; }
  const String& previewProjectId() const { return previewProjectId_; }
  size_t previewThreadCount() const { return previewThreadCount_; }
  const ThreadOption* previewThread(size_t index) const {
    return index < previewThreadCount_ ? &previewThreads_[index] : nullptr;
  }
  const String& previewDetail() const { return previewDetail_; }
  bool previewActive() const { return previewActive_; }
  void endPreview() { previewActive_ = false; }
  size_t projectCount() const { return projectCount_; }
  const BrowseProject* project(size_t index) const;
  int selectedProjectIndex() const { return selectedProjectIndex_; }
  const String& projectsDetail() const { return projectsDetail_; }
  bool projectsTruncated() const { return projectsTruncated_; }

  bool selectProject(size_t index);

  // ---------------------------------------------------------------------------------------------
  // Creating a thread
  // ---------------------------------------------------------------------------------------------
  //
  // `POST /v1/device/threads` with a durable clientRequestId. A project with no threads used to leave a
  // controller with nothing to point at and no way out except the web console — which is the one
  // place the owner is not standing when they pick the device up.
  //
  // Two things about the contract shape the firmware side (docs/hardware-protocol.md, "Creating a
  // thread"):
  //
  //   The returned row is shaped EXACTLY like a row from GET /v1/device/threads, so it is spliced
  //   into the list already on screen rather than waiting for a re-fetch.
  //
  //   CREATING ALSO SELECTS. The device is bound to the new thread by the time the 201 arrives, and
  //   a follow-up POST /v1/device/config/thread is not merely redundant but harmful: it validates
  //   against T3's live snapshot, which lags the dispatch, so it can 404 on a thread that certainly
  //   exists.
  //
  // The title is optional and this board never sends one — there is no keyboard, and the gateway
  // names it "<D Mon HH:MM> - <device label>" with uniqueness guaranteed. `title` is on the
  // signature anyway because a transcript is words, and T3 only auto-retitles a thread still
  // carrying its own default, so a name supplied here is the name the thread keeps.
  bool createThread(const String& title = String());

  // Valid after a successful createThread(). Shaped as a thread row, ready to splice.
  const BrowseThread& createdThread() const { return created_; }

  // One line a person can act on, from the error table in the protocol doc. Empty on success.
  const String& createDetail() const { return createDetail_; }
  int createStatus() const { return createStatus_; }

  // What the gateway last said is bound, which is not necessarily what this device asked for: a
  // selection that failed leaves these unchanged.
  const String& boundEnvironmentId() const { return boundEnvironmentId_; }
  const String& boundProjectId() const { return boundProjectId_; }

  // Display labels for the breadcrumb, resolved against whichever list has been fetched. Falls
  // back to a shortened id, which is still a stable handle somebody can match in the console, and
  // to an empty string when nothing is bound at all.
  String environmentLabel() const;
  String projectLabel() const;

  // Bumped whenever anything above changes, so a renderer can repaint on a comparison rather than
  // on a diff. Mirrors GatewayClient::revision().
  uint32_t revision() const { return revision_; }

  // True when the last selection changed the environment, which clears the project and thread
  // server-side. The caller has to re-fetch both rather than trusting what it has.
  bool consumeContextCleared();

 private:
  bool postAgentIntent(const String& intent, const String& threadId, String& resultThreadId);
  BrowseAgent agents_[12];
  size_t agentCount_ = 0;
  bool directAgentsSupported_ = false;
  String agentDetail_;
  int request(const char* method, const char* path, const String& body, String& response);
  void touch() { revision_ += 1; }

  DeviceStore* store_ = nullptr;
  bool previewActive_ = false;
  bool previewContractReady_ = false;
  String previewEnvironmentId_, previewProjectId_, previewDetail_;
  ThreadOption previewThreads_[kMaxThreadOptions];
  size_t previewThreadCount_ = 0;

  BrowseEnvironment environments_[kMaxBrowseEnvironments];
  size_t environmentCount_ = 0;
  int selectedEnvironmentIndex_ = -1;
  String environmentsDetail_;
  bool environmentsTruncated_ = false;

  BrowseProject projects_[kMaxBrowseProjects];
  size_t projectCount_ = 0;
  int selectedProjectIndex_ = -1;
  String projectsDetail_;
  bool projectsTruncated_ = false;

  String boundEnvironmentId_;
  String boundProjectId_;
  BrowseThread created_;
  String createDetail_;
  int createStatus_ = 0;
  bool contextCleared_ = false;
  uint32_t revision_ = 1;
};
