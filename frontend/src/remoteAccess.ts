export type RemoteAccessMode = "serve" | "funnel";

export const remoteAccessOptions: Array<{
  id: RemoteAccessMode;
  label: string;
  visibility: string;
  description: string;
}> = [
  {
    id: "serve",
    label: "Tailscale Serve",
    visibility: "Private tailnet",
    description: "Recommended. Reach Next Coder over HTTPS from your signed-in Tailscale devices.",
  },
  {
    id: "funnel",
    label: "Tailscale Funnel",
    visibility: "Public internet",
    description: "Advanced. Publish the gateway URL to anyone on the internet while Clerk still protects the console.",
  },
];

export function buildGatewayTunnelSetupCommand(mode: RemoteAccessMode) {
  return `npm run setup:tunnel -- --mode ${mode} --write-env`;
}

export function buildGatewayTunnelDisableCommand(mode: RemoteAccessMode) {
  return `npm run setup:tunnel -- --mode ${mode}-off`;
}
