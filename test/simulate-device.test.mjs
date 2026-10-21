import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("device simulator stores credentials owner-only without printing secrets", async (t) => {
  const deviceSecret = "device_secret_that_must_not_reach_stdout";
  const apiToken = "api_token_that_must_not_reach_stdout";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/users/dev") {
      response.end(JSON.stringify({ apiToken: { secret: apiToken } }));
      return;
    }
    if (request.url === "/v1/devices") {
      assert.equal(request.headers.authorization, `Bearer ${apiToken}`);
      response.end(JSON.stringify({ device: { id: "dev_simulated" }, secret: deviceSecret }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const directory = await mkdtemp(join(tmpdir(), "next-coder-simulator-"));
  const credentialFile = join(directory, "private", "device.json");
  const result = await run(process.execPath, ["scripts/simulate-device.mjs"], {
    NEXT_CODER_URL: `http://127.0.0.1:${server.address().port}`,
    NEXT_CODER_SIMULATOR_CREDENTIAL_FILE: credentialFile,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(deviceSecret), false);
  assert.equal(result.stdout.includes(apiToken), false);
  assert.match(result.stdout, /Registered simulated device dev_simulated/u);
  const saved = JSON.parse(await readFile(credentialFile, "utf8"));
  assert.deepEqual(saved, {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    deviceId: "dev_simulated",
    deviceSecret,
  });
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
});

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
