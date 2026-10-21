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
// when it is done. Paint the pending frame first, then call.

#include <Arduino.h>

#include "DeviceStore.h"

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

class GatewayBrowse {
 public:
  void begin(DeviceStore& store);

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
  // `POST /v1/device/threads` with an empty body. A project with no threads used to leave a
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
  int request(const char* method, const char* path, const String& body, String& response);
  void touch() { revision_ += 1; }

  DeviceStore* store_ = nullptr;

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
