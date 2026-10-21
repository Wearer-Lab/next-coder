import { Cable, Fingerprint, KeyRound, PackagePlus } from "lucide-react";

import { Button, cn } from "../ui";

export type DeviceOnboardingFlow = "preprovision" | "register" | "claim";

/**
 * The fleet's topbar actions, in the "intelligence design" language: a hairline glass dock that
 * holds quiet links and one glowing call to action, the way the marketing navigation holds its
 * own. The shared Button primitive already renders pills, so the cluster only supplies the dock
 * and the emphasis.
 */
export function DeviceActionCluster({
  onOpen,
  className,
}: {
  onOpen: (flow: DeviceOnboardingFlow) => void;
  className?: string;
}) {
  return (
    <div className={cn("device-action-cluster ac-fleet-cluster", className)} aria-label="Add a device">
      <Button size="sm" variant="ghost" onClick={() => onOpen("preprovision")}>
        <Fingerprint className="size-3.5" /> Pre-provision
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onOpen("register")}>
        <PackagePlus className="size-3.5" /> Register
      </Button>
      <Button size="sm" variant="primary" onClick={() => onOpen("claim")}>
        <KeyRound className="size-3.5" /> Claim
      </Button>
    </div>
  );
}

export function EnvironmentActionCluster({
  onConnect,
  className,
}: {
  onConnect: () => void;
  className?: string;
}) {
  return (
    <div className={cn("environment-action-cluster ac-fleet-cluster", className)}>
      <Button size="sm" variant="primary" onClick={onConnect}>
        <Cable className="size-3.5" /> Connect environment
      </Button>
    </div>
  );
}
