# Security policy

Next Coder authenticates people, devices, and connectors, holds device credentials and
encrypted T3 tokens, and dispatches commands to coding agents on users' machines. Vulnerabilities
in it can reach a user's development environment, so please report them privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/Wearer-Lab/next-coder/security/advisories/new>

Do not open a public issue or pull request for a security problem. Include the affected surface
(gateway, console, connector CLI, Cloudflare Worker/Container, Convex functions, or firmware), a
reproduction, and the impact you believe it has. Redact any real tokens, device secrets, or user
content from the report.

You should receive an acknowledgement within a few days. There is no bug bounty programme.

## Scope

In scope: everything in this repository, including the `@wearer-haitch/connector` package, the
Cloudflare edge and control-plane code, the Convex functions, and the firmware under `firmware/`.

Out of scope: T3 Code itself, Clerk, Convex, Cloudflare, and other third-party services, which have
their own disclosure programmes; and findings that require a compromised host machine, since the
connector runs with the user's own privileges by design.

## Operational guidance

- Credential handling, secret rotation, TLS requirements, and the firmware rollback ceremony are
  documented in [docs/production-security.md](docs/production-security.md).
- Connector credential rotation and native secret storage are described in
  [docs/npm-connector-release.md](docs/npm-connector-release.md) and the connector README.
- `npm run security:repo` is a fail-closed scan of tracked files for live configs, environment
  files, private keys, and high-confidence token signatures. It runs in CI on every push.
