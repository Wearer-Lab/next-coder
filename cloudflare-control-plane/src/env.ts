import type { AgentControllerGatewayContainer } from "./gatewayContainer";

export interface ConnectorRouterService {
  routeConnectorRequest(environmentId: string, request: unknown): Promise<any>;
  pollConnectorRequest(environmentId: string, requestId: string, waitMs?: number): Promise<any>;
  cancelConnectorRequest(environmentId: string, requestId: string): Promise<any>;
  openConnectorSubscription(environmentId: string, input: unknown): Promise<any>;
  pollConnectorSubscription(environmentId: string, leaseId: string, after: number, waitMs?: number): Promise<any>;
  closeConnectorSubscription(environmentId: string, leaseId: string): Promise<any>;
  routeConnectorRevocation(environmentId: string, connectorId: string, reason?: string): Promise<any>;
}

export interface RuntimeBindings {
  AGENT_CONTROLLER_GATEWAY: DurableObjectNamespace<AgentControllerGatewayContainer>;
  CONNECTOR_ROUTER: ConnectorRouterService;

  DEPLOYMENT_ENVIRONMENT: "local" | "staging" | "production";
  PUBLIC_BASE_URL?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  CLERK_JWT_ISSUER_DOMAIN?: string;
  CONNECTOR_TICKET_AUDIENCE?: string;
  CONTAINER_STARTUP_TIMEOUT_MS?: string;
  CONTAINER_RESPONSE_HEADER_TIMEOUT_MS?: string;
  TELEMETRY?: AnalyticsEngineDataset;
  TELEMETRY_SUCCESS_SAMPLE_RATE?: string;

  // Worker secrets passed only when the singleton container starts.
  CONVEX_URL?: string;
  GATEWAY_CONVEX_SECRET?: string;
  CLERK_SECRET_KEY?: string;
  T3_TOKEN_ENCRYPTION_KEY?: string;
  MEDIA_SIGNING_KEY?: string;
  FIRMWARE_DOWNLOAD_SIGNING_KEY?: string;
  BILLING_WEBHOOK_SECRET?: string;
  FACTORY_TOKEN?: string;
  OTA_SIGNING_KEY?: string;
  RATE_LIMIT_REDIS_URL?: string;
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  FIRMWARE_S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  GATEWAY_TLS_ROOT_CA_PEM?: string;
  GATEWAY_TLS_NEXT_ROOT_CA_PEM?: string;
  WEB_PUSH_VAPID_KEYS?: string;
  WEB_PUSH_VAPID_KEY_ID?: string;
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  WEB_PUSH_VAPID_SUBJECT?: string;
  WEB_PUSH_ALLOWED_HOSTS?: string;
  WEB_PUSH_STORAGE_ENCRYPTION_KEY?: string;
}

export type CloudflareControlPlaneBindings = RuntimeBindings;
