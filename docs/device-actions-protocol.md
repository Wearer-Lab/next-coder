# Device actions and controls protocol

Next Coder separates reusable user content, device policy, the physical control layout, and
firmware features. The gateway owns action bodies and authorization. A controller receives only
display metadata and opaque action identifiers; prompt text and shell commands are never copied
into the device controls payload.

## Resource model

- **Action**: a user-owned prompt, policy-screened shell request, media prompt template, or macro.
- **Control layout**: an ordered, revisioned list of system controls and action references assigned
  to one device.
- **Device profile**: the capability boundary evaluated for every action invocation.
- **Hardware manifest**: firmware-reported protocol version, physical features, and render limits.
- **Firmware policy**: the owner's release channel and update mode for one device.

Status and stop are system controls. They are not editable actions. A macro never bypasses policy:
the gateway evaluates every underlying step with the invoking device or user's policy context.

## Hardware manifest

Protocol v2 controllers include a manifest in every heartbeat:

```json
{
  "protocolVersion": 2,
  "features": ["display", "buttons", "camera", "ota"],
  "limits": {
    "menuItems": 8,
    "labelCharacters": 18,
    "mediaUploadBytes": 1048576
  }
}
```

The gateway uses the manifest together with the assigned profile, environment, and current run
state to decide which controls are enabled. Protocol v1 devices continue to receive the legacy
`config.menu`, `defaultPrompt`, and `shellCommand` fields during migration.

## Device controls

```http
GET /v1/device/controls
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "revision": 12,
  "controls": [
    {
      "id": "system_status",
      "actionId": "system_status",
      "label": "Status",
      "kind": "status",
      "enabled": true
    },
    {
      "id": "control_run_tests",
      "actionId": "action_run_tests",
      "label": "Run tests",
      "kind": "remote_action",
      "requiresThread": true,
      "requiresConfirmation": true,
      "enabled": true
    },
    {
      "id": "system_stop",
      "label": "Stop run",
      "kind": "stop",
      "requiresThread": true,
      "requiresConfirmation": true,
      "enabled": false,
      "reason": "No active run"
    }
  ]
}
```

Supported control kinds are `status`, `remote_action`, `capture_audio`, `capture_image`, `stop`,
and `reset`. Firmware must not infer behavior from the label. Unknown kinds and controls with
`enabled: false` are not executable.

`requiresThread` makes selected task context a fail-closed precondition. The gateway returns the
control disabled when that context is absent, and firmware also checks its current config before
dispatch. `requiresConfirmation` requires a local review screen and a second OK before the request;
it does not replace a later gateway/owner approval required by policy.

After persisting and rendering a revision, the controller acknowledges it:

```http
POST /v1/device/controls/ack
content-type: application/json

{ "revision": 12 }
```

This distinguishes cloud-saved layouts from layouts that are actually active on the hardware.

### Controller Details display parity

The Controls tab and CrowPanel use the same hierarchical menu contract. The saved layout contains
only owner-assigned thread actions and is bounded by the device's `menuItems` capacity. Firmware
keeps those reusable actions out of the root menu, whose exact order is:

1. `Threads / LIST` (or the available task count)
2. `Gateway / NET`
3. `Firmware / CHECK` (or `Update <version> / READY`)

`Threads` opens the paged task list. OK on a task both makes it current when necessary and opens its
`T//ACTIONS` screen. That child screen contains every assigned control in saved order, three rows at
a time. EXIT returns from thread actions to the thread list, then from the list to root.

Both surfaces use the same metadata precedence: missing required task context is `THREAD`,
unavailable controls are `LOCK`, status is `VIEW`, and reviewed actions plus Stop are `CONFIRM`.
New entries authored in the Actions Library become eligible for this child list when the owner adds
them to the controller in Controller Details; creating an action does not silently expand a physical
device's authority.

Controller Details labels its preview `Unsaved`, `pending`, or `synced`. A saved revision is only
`synced` after the controller acknowledges that exact revision. The preview cursor is a simulator;
the gateway intentionally does not claim to know the rotary cursor's transient local position.

## Action execution

```http
POST /v1/device/actions/action_run_tests/run
content-type: application/json

{}
```

For a capture action, firmware uploads the bytes first and supplies the resulting media id:

```json
{ "mediaUploadId": "media_..." }
```

The gateway verifies that the action belongs to the owner and is assigned to the invoking device,
resolves the target environment and thread, normalizes the intent, evaluates policy, and records a
command and audit event before dispatching to T3 Code.

## T3 Code contract

Actions and control layouts are gateway resources. T3 Code does not store them. Execution uses the
existing orchestration surface:

The ESP32 never pairs with T3 Code and never stores a T3 bearer token. It authenticates only to
Next Coder with its per-device credential. Next Coder is the trusted orchestration
adapter: it resolves the owner-selected environment and thread, holds the T3 access token, applies
the device profile and policy, then sends typed T3 commands. This matches T3 Code's own
[browser → WebSocket server → orchestration engine architecture](https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md)
and its [one-time remote pairing/session model](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md).

For a T3 server on the gateway machine, the gateway connects over loopback. For a T3 server on a
different machine, pair the gateway to the private Tailscale Serve URL. Tailscale access to the
Next Coder console/device API is a separate tunnel; exposing one service does not expose the
other. ESP32 controllers normally use the gateway's LAN URL and do not run Tailscale themselves.

| Operation | T3 command or API |
| --- | --- |
| Status | `GET /api/orchestration/snapshot`, compressed to the selected thread/session |
| Prompt/media/shell request | `thread.turn.start` |
| Stop | `thread.session.stop` |
| Interrupt | `thread.turn.interrupt` |
| Approval response | `thread.approval.respond` |

Status is selected-thread aware. Its compact response preserves `session.status`,
`latestTurn.state`, runtime/interaction mode, and counts of unresolved approval and user-input
activities. The firmware renders that response only after an explicit Status press; its routine
five-second display poll remains the cheap gateway summary.

Normal pairing requests `orchestration:read` and `orchestration:operate`. Direct terminal writes
remain a separate advanced feature and require the opt-in `terminal:operate` scope. Saved shell
actions use the policy-screened, agent-mediated path unless they explicitly use the direct terminal
intent and the environment and device profile both grant it.

## Device response recommendations

For a device-originated saved action, Next Coder appends a hidden bounded instruction that
offers the model only the action ids currently assigned and enabled for that controller. The model
may append one marker with zero to two recommendations:

```html
<!--AC_FOLLOWUPS:["action_run_tests","action_review"]-->
```

The marker is removed from the text rendered on hardware. On every response read, the gateway
revalidates ids against the current Controller Details layout and removes unknown, disabled,
duplicate, system, or unassigned entries. Recommendations do not bypass local confirmation, device
profile enforcement, gateway policy, owner approval, target resolution, or audit logging. Web/user
turns are not modified, and the model may omit the marker when no assigned action is relevant.

## Firmware updates

Owners select `stable` or `beta` and one of `manual`, `notify`, or `automatic`. Firmware release
publication remains factory/admin-only. A protocol v2 device reports update progress with:

```http
POST /v1/device/firmware/status
content-type: application/json

{
  "state": "downloading",
  "version": "0.2.0",
  "targetVersion": "0.3.0",
  "progress": 42,
  "detail": "Downloading signed image"
}
```

Firmware verifies the signed manifest and SHA-256 before applying an image. A newly booted OTA
partition stays pending until the controller successfully reaches the gateway and confirms the
running release. The secure build requires bootloader rollback support, persists the source and
target versions before restart, and reports `rolled_back` if the previous image returns.
