import assert from "node:assert/strict";
import test from "node:test";
import { orchestratorStateDir } from "./index.mjs";

test("resolves stateDir from the orchestrator machine", () => {
  const ctx = {
    get(name, strict) {
      assert.equal(name, "orchestrator");
      assert.equal(strict, false);
      return { machine: { stateDir: "/tmp/superagent-state" } };
    },
  };
  assert.equal(orchestratorStateDir(ctx), "/tmp/superagent-state");
});

test("returns undefined while the orchestrator is loading", () => {
  assert.equal(orchestratorStateDir({ get: () => undefined }), undefined);
  assert.equal(orchestratorStateDir({ get: () => ({}) }), undefined);
});
