# Contributing to Next Coder

Thanks for your interest. This document covers the mechanics; the engineering expectations for a
complete change live in [AGENTS.md](AGENTS.md), and the architecture and protocol invariants in
[CLAUDE.md](CLAUDE.md). Read both before opening a pull request that touches more than one surface.

## Prerequisites

- Node.js 22 or newer.
- For firmware: [PlatformIO](https://platformio.org/) and the pinned pioarduino toolchain declared in
  each board's `platformio.ini`. Copy `include/controller_config.example.h` to
  `controller_config.h` in the board folder; live configs are ignored by Git and rejected by the
  secret scan if tracked.
- Optional: a [T3 Code](https://github.com/pingdotgg/t3code) instance, or `node scripts/mock-t3.mjs`
  for a fake one.

## Getting started

```bash
npm ci
npm run dev:server     # gateway on http://127.0.0.1:3996
npm run dev:app        # Vite console on http://localhost:5173
```

See the README for Clerk, Convex, media storage, and transcription configuration. Nothing in
`.env.example` is required for local development against the in-memory store.

## Before you open a pull request

Run the same gates CI runs:

```bash
npm test                  # build, typechecks, frontend, server, connector, and Cloudflare suites
npm run security:repo     # fail-closed tracked-file and secret signature scan
npm run check:docs        # relative-link gate for maintained documentation
```

Targeted commands for a single suite or file are listed in the README under "Test". Firmware changes
should compile for every environment they touch (`npm run build:firmware:all` builds the whole
matrix from placeholder configs).

## What a good change looks like

- **Follow the existing shape.** Server code is dependency-free ESM `.mjs`; new endpoints go in the
  `handle()` chain in `src/app.mjs`; a new store method is added to the memory, file, and Convex
  adapters together. AGENTS.md has the full checklist.
- **Test against real shapes.** Server tests use `node:test`, spin up a real `createApp()` server,
  and stub `globalThis.fetch` for T3. Captured T3 fixtures live in `test/fixtures/`.
- **Be truthful about evidence.** Local tests prove local behaviour. Do not describe something as
  deployed, hardware-verified, or live-qualified unless it has been, and update
  `roadmap/IMPLEMENTATION-STATUS.md` when the verified state changes.
- **Never commit secrets or user content.** Device secrets, Wi-Fi credentials, tokens, transcripts,
  and vendor download kits stay out of the tree. The secret scan is a backstop, not a substitute for
  care.
- **Keep documentation current.** User-visible behaviour changes update `README.md` or `docs/`;
  protocol changes update `docs/api.md` or `docs/hardware-protocol.md`.

## Reporting bugs and proposing features

Open a GitHub issue with the surface involved (gateway, console, connector, firmware, cloud), what
you expected, what happened, and how to reproduce it. Redact tokens, device ids, and transcripts
from logs before pasting them. Security problems go through [SECURITY.md](SECURITY.md) instead.

## Licensing

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
