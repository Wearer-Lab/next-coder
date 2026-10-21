#!/usr/bin/env node

import { main } from "../src/cli.mjs";
import { createCredentialStore } from "../src/credentialStore.mjs";

const credentialStore = await createCredentialStore();
process.exitCode = await main(process.argv.slice(2), { credentialStore });
