import assert from "node:assert/strict";
import test from "node:test";

import { legacyVariableName, readEnv } from "../scripts/environment.mjs";

test("a renamed variable reads the new name first", () => {
  assert.equal(readEnv({ NEXT_CODER_STAGING_URL: "https://staging.example" }, "NEXT_CODER_STAGING_URL"), "https://staging.example");
});

test("a renamed variable falls back to the pre-rename name", () => {
  assert.equal(
    readEnv({ AGENT_CONTROLLER_STAGING_URL: "https://staging.example" }, "NEXT_CODER_STAGING_URL"),
    "https://staging.example",
  );
});

test("an empty new value still falls back, because a missing workflow variable expands to an empty string", () => {
  assert.equal(
    readEnv({ NEXT_CODER_STAGING_URL: "", AGENT_CONTROLLER_STAGING_URL: "https://staging.example" }, "NEXT_CODER_STAGING_URL"),
    "https://staging.example",
  );
});

test("the new name wins when both are configured", () => {
  assert.equal(
    readEnv({ NEXT_CODER_STAGING_URL: "https://new.example", AGENT_CONTROLLER_STAGING_URL: "https://old.example" }, "NEXT_CODER_STAGING_URL"),
    "https://new.example",
  );
});

test("a variable that was never renamed is read exactly as it is", () => {
  assert.equal(readEnv({ FACTORY_TOKEN: "token" }, "FACTORY_TOKEN"), "token");
  assert.equal(readEnv({}, "FACTORY_TOKEN"), undefined);
  assert.equal(legacyVariableName("FACTORY_TOKEN"), null);
});

test("the legacy spelling is derived only from the renamed prefix", () => {
  assert.equal(legacyVariableName("NEXT_CODER_DRILL_ACCESS_TOKEN"), "AGENT_CONTROLLER_DRILL_ACCESS_TOKEN");
  assert.equal(legacyVariableName("NEXT_CODER_URL"), "AGENT_CONTROLLER_URL");
});
