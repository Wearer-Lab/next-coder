import { Check, Minus, ShieldAlert } from "lucide-react";

import type { DeviceProfile } from "../types";
import { cn } from "../ui";
import "./intelligence-control.css";

/**
 * Human wording for the capability ids returned by GET /v1/device-profiles. These mirror
 * the intent types screened in src/policy.mjs; unknown ids fall through to their raw name
 * so a new server capability still shows up instead of silently disappearing.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  status: "Read agent and environment status",
  agent_prompt: "Send agent prompts",
  media_prompt: "Attach image and audio context",
  session_control: "Stop and interrupt sessions",
  approval_response: "Answer approvals — the gateway's holds, and the agent's own requests",
  approval_response_persistent: "Grant an agent a permission for the whole session (\"allow for this session\")",
  approval_response_always: "Grant an agent a permission from now on, not just for one session (\"always allow\")",
  shell_input: "Run shell commands (dangerous ones still need approval)",
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability.replaceAll("_", " ");
}

export function profileCapabilities(
  profiles: readonly DeviceProfile[],
  profileId: string | null | undefined,
): string[] {
  if (!profileId) return [];
  return profiles.find((profile) => profile.id === profileId)?.capabilities ?? [];
}

export interface CapabilityDiff {
  granted: string[];
  revoked: string[];
}

export function diffCapabilities(
  from: readonly string[],
  to: readonly string[],
): CapabilityDiff {
  const before = new Set(from);
  const after = new Set(to);
  return {
    granted: to.filter((capability) => !before.has(capability)),
    revoked: from.filter((capability) => !after.has(capability)),
  };
}

function CapabilityList({ capabilities }: { capabilities: readonly string[] }) {
  if (capabilities.length === 0) {
    return (
      <p className="mt-2 text-xs text-ink-faint">
        This profile grants no intents. The device can authenticate but every command is refused.
      </p>
    );
  }
  return (
    <ul className="mt-2 grid gap-1">
      {capabilities.map((capability) => (
        <li key={capability} className="flex items-start gap-1.5 text-xs leading-snug text-ink-muted">
          <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden="true" />
          <span>{capabilityLabel(capability)}</span>
        </li>
      ))}
    </ul>
  );
}

interface ProfilePickerProps {
  /** Radio group name; must be unique per picker on the page. */
  name: string;
  legend: string;
  description?: string;
  profiles: readonly DeviceProfile[];
  value: string;
  onChange: (profileId: string) => void;
  /** The profile currently assigned on the server, used to explain what a change does. */
  assignedProfileId?: string | null;
  className?: string;
  /**
   * Grid classes for the card container. Cards stack in one column by default, which suits a
   * narrow sidebar; a full-width placement passes column classes so three tall capability lists
   * sit side by side instead of running the page off the bottom of the screen.
   */
  cardsClassName?: string;
}

/**
 * Profile picker that surfaces each profile's capability list, so an operator can see
 * what a profile grants a piece of hardware *before* assigning it.
 */
export function ProfilePicker({
  name,
  legend,
  description,
  profiles,
  value,
  onChange,
  assignedProfileId = null,
  className,
  cardsClassName,
}: ProfilePickerProps) {
  const diff = assignedProfileId && assignedProfileId !== value
    ? diffCapabilities(
      profileCapabilities(profiles, assignedProfileId),
      profileCapabilities(profiles, value),
    )
    : null;

  return (
    <fieldset className={cn("ic-scope ic-picker min-w-0", className)}>
      <legend className="ac-eyebrow">{legend}</legend>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">{description}</p>
      ) : null}
      <div className={cn("mt-2 grid gap-2", cardsClassName)}>
        {profiles.map((profile) => {
          const selected = profile.id === value;
          return (
            <label
              key={profile.id}
              className={cn(
                "profile-card",
                selected && "profile-card--selected",
              )}
              data-selected={selected || undefined}
            >
              <input
                type="radio"
                name={name}
                value={profile.id}
                checked={selected}
                onChange={() => onChange(profile.id)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="ic-title text-sm">{profile.label ?? profile.id}</span>
                  <span className="font-mono text-[10px] text-ink-faint">{profile.id}</span>
                  {profile.id === assignedProfileId ? (
                    <span className="profile-assigned">
                      assigned
                    </span>
                  ) : null}
                </span>
                {profile.description ? (
                  <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                    {profile.description}
                  </span>
                ) : null}
                <CapabilityList capabilities={profile.capabilities ?? []} />
              </span>
            </label>
          );
        })}
      </div>
      {diff && (diff.granted.length > 0 || diff.revoked.length > 0) ? (
        <div
          className="profile-diff ic-note mt-3 border border-warning/25 bg-warning/8 p-3 text-xs"
          role="status"
        >
          <p className="flex items-center gap-1.5 font-semibold text-warning-strong">
            <ShieldAlert className="size-3.5" aria-hidden="true" /> Saving this profile changes what the device may do
          </p>
          {diff.granted.length > 0 ? (
            <ul className="mt-2 grid gap-1">
              {diff.granted.map((capability) => (
                <li key={capability} className="flex items-start gap-1.5 text-success-strong">
                  <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>Grants: {capabilityLabel(capability)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {diff.revoked.length > 0 ? (
            <ul className="mt-2 grid gap-1">
              {diff.revoked.map((capability) => (
                <li key={capability} className="flex items-start gap-1.5 text-danger">
                  <Minus className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>Revokes: {capabilityLabel(capability)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
