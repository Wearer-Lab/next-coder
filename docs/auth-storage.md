# Clerk And Convex Authentication

The platform is moving to:

- Clerk for customer authentication and user identity.
- Convex for durable multi-tenant platform storage.
- Device secrets for hardware authentication.

## Clerk

Set gateway environment:

```text
AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=sk_live_or_test_...
VITE_CLERK_PUBLISHABLE_KEY=pk_live_or_test_...
CLERK_AUTHORIZED_PARTIES=https://gateway.example.com
```

For local development, use `clerk init --app YOUR_CLERK_APP_ID`. The CLI writes the two keys above to the gitignored `.env.local`.

When `AUTH_PROVIDER=clerk`, platform routes expect:

```text
authorization: Bearer CLERK_SESSION_OR_JWT
```

The gateway verifies bearer tokens and same-origin session cookies with `@clerk/backend`, then synchronizes the verified Clerk `userId`, name, and primary email. Device credentials, factory credentials, and OTA signing keys are separate from Clerk sessions.

The dashboard reads public auth settings from:

```text
GET /v1/auth/config
```

When Clerk is enabled, the React app opens Clerk sign-in and calls `getToken()` for each API request so Clerk can refresh the session. Live events authenticate with the same-origin Clerk cookie. No Clerk or platform bearer token is stored in `localStorage`.

Legacy integration tests and CLI-only development can explicitly use:

```text
AUTH_PROVIDER=dev
DEMO_MODE=1
```

The development token endpoint `POST /v1/users/dev` is disabled automatically when `AUTH_PROVIDER=clerk`. The React dashboard never exposes this endpoint or a fake development profile.

## Convex

Convex files are scaffolded in:

```text
convex/
```

They include:

- `auth.config.ts`: Convex JWT validation against Clerk.
- `schema.ts`: users, API tokens, devices, environments, media uploads, commands, firmware releases,
  owner-scoped release rollouts and per-target assignments, audit logs.
- `users.ts`: current user lookup and upsert.
- `nextCoder.ts`: initial device/config/firmware queries and mutations.
- `gatewayStore.ts`: Store API queries and mutations used by the Node gateway.

Set:

```text
STORAGE_PROVIDER=convex
CONVEX_URL=https://your-deployment.convex.cloud
CONVEX_DEPLOYMENT=dev:your-deployment
GATEWAY_CONVEX_SECRET=shared-secret-between-gateway-and-convex
T3_TOKEN_ENCRYPTION_KEY=shared-token-encryption-secret
CLERK_JWT_ISSUER_DOMAIN=https://your-clerk-issuer.clerk.accounts.dev
```

Run:

```bash
npm run convex:dev
```

Validate the gateway route layer against Convex:

```bash
npm run smoke:convex
```

The gateway route layer is async-safe for Convex-backed storage. `src/convexStore.mjs` maps the Node Store API to `convex/gatewayStore.ts` functions. The Node gateway generates device/API secrets and sends only hashes to Convex. T3 access tokens are encrypted by the gateway before storage and decrypted only for internal T3 health checks and dispatch calls.

`gatewayStore.ts` functions are public Convex functions guarded by `GATEWAY_CONVEX_SECRET`. Set the same high-entropy values in both the VPS environment and the Convex deployment environment:

```bash
npx convex env set GATEWAY_CONVEX_SECRET 'replace-with-generated-secret'
npx convex env set T3_TOKEN_ENCRYPTION_KEY 'replace-with-generated-token-encryption-secret'
```

If `T3_TOKEN_ENCRYPTION_KEY` is omitted for Convex storage, the gateway falls back to `GATEWAY_CONVEX_SECRET` for token encryption. Use a dedicated token encryption key in production so it can be rotated separately from the Convex gateway guard.

## Ownership Model

Clerk users own:

- Claimed devices.
- T3 Code environments.
- Media uploads.
- Command/audit history.

Factory credentials own:

- Batch pre-provisioning.
- Firmware release publication.

Devices own:

- Heartbeats.
- Display/config/firmware polling.
- Media upload and intent submission after claim.

## Next Convex Work

Next productionization steps:

- Replace the development `CLERK_JWT_ISSUER_DOMAIN` placeholder with the real Clerk issuer.
- Add migration/import scripts if existing file-store data must move into Convex.
