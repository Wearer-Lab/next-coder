import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readEnv } from "./environment.mjs";

const baseUrl = readEnv(process.env, "NEXT_CODER_URL") ?? "http://127.0.0.1:3996";
const userId = readEnv(process.env, "NEXT_CODER_USER_ID") ?? "user_dev";
const credentialFile = resolve(
  readEnv(process.env, "NEXT_CODER_SIMULATOR_CREDENTIAL_FILE")
    ?? ".data/simulated-device-credential.json",
);

async function main() {
  const authHeaders = await createDevAuthHeaders();
  const device = await post("/v1/devices", {
    label: "Simulated controller",
    profile: "next-coder",
  }, authHeaders);

  await persistCredential({
    baseUrl,
    deviceId: device.device.id,
    deviceSecret: device.secret,
  });
  console.log(`Registered simulated device ${device.device.id}.`);
  console.log(`Credential saved with owner-only permissions: ${credentialFile}`);
}

async function persistCredential(credential) {
  await mkdir(dirname(credentialFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(credentialFile), 0o700);
  const temporaryFile = `${credentialFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(credential, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryFile, credentialFile);
  await chmod(credentialFile, 0o600);
}

async function createDevAuthHeaders() {
  const created = await post("/v1/users/dev", {
    userId,
    email: "dev@example.local",
    tokenLabel: "Simulated device script",
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

async function post(path, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
