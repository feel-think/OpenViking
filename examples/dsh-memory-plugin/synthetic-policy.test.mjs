import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  EMPTY_POLICY,
  SyntheticPolicyStore,
  captureAllowed,
  loadSyntheticPolicy,
  matchesRule,
  messageBody,
  syntheticRecallQuery,
} from "./synthetic-policy.mjs";
import { captureEvent } from "./capture.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";

const POLICY = {
  version: 1,
  recall: [
    { match: { source: { kind: "dsh-superagent", form: "relay" }, body: { kind: "candidate" } } },
    { match: { source: { kind: "dsh-superagent", form: "relay" }, body: { kind: "follow_up" } } },
    { match: {
      session: { agentPreset: "dsh-superagent-worker" },
      source: { kind: "dsh-superagent", form: "relay" },
      body: { has: ["ticket_id", "trigger"] },
    } },
    { match: {
      session: { agentPreset: "dsh-superagent-worker" },
      source: { kind: "dsh-superagent", form: "relay" },
      body: { has: ["trigger_id", "text"] },
    } },
  ],
  capture: [{ match: { source: { kind: "dsh-superagent" } } }],
};

const message = (body, source = { kind: "dsh-superagent", form: "relay" }) => ({
  role: "user",
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
  source,
});

const worker = { header: { agentPreset: "dsh-superagent-worker" } };

test("parses only a JSON object body", () => {
  assert.deepEqual(messageBody(message({ kind: "candidate", text: "hello" })), { kind: "candidate", text: "hello" });
  assert.equal(messageBody(message("not json")), null);
  assert.equal(messageBody(message([1, 2])), null);
  assert.equal(messageBody({ content: [] }), null);
});

test("matches source, session and top-level body selectors", () => {
  const candidate = message({ kind: "candidate", text: "fix it" });
  assert.equal(matchesRule(POLICY.recall[0], candidate, messageBody(candidate), worker), true);
  assert.equal(matchesRule(POLICY.recall[0], candidate, messageBody(candidate), { header: {} }), true);
  const assigned = { ticket_id: "t", title: "T", trigger: { text: "do it" } };
  assert.equal(matchesRule(POLICY.recall[2], message(assigned), assigned, worker), true);
  assert.equal(matchesRule(POLICY.recall[2], message({ ticket_id: "t", assignment: 1 }), { ticket_id: "t", assignment: 1 }, worker), false);
  assert.equal(matchesRule(POLICY.recall[2], message({ ticket_id: "t" }), { ticket_id: "t" }, worker), false);
  assert.equal(matchesRule(POLICY.recall[2], message(assigned), assigned, { header: {} }), false);
  const followUp = { trigger_id: "t", from: "ou_x", text: "also update the label" };
  assert.equal(matchesRule(POLICY.recall[3], message(followUp), followUp, worker), true);
  assert.equal(matchesRule(POLICY.recall[3], message(assigned), assigned, worker), false);
  assert.equal(matchesRule(POLICY.recall[3], message({ trigger_id: "t", from: "ou_x", summary: "x" }), { trigger_id: "t", from: "ou_x", summary: "x" }, worker), false);
});

test("capture policy is source-only and does not parse body", () => {
  const synthetic = message("not json");
  assert.equal(captureAllowed(POLICY, synthetic), true);
  assert.equal(captureAllowed(POLICY, message("anything", { kind: "user" })), false);
  assert.equal(captureAllowed(EMPTY_POLICY, synthetic), false);
});

test("builds recall queries from matching synthetic messages", () => {
  const messages = [
    message({ kind: "candidate", text: "fix the button" }),
    message({ kind: "follow_up", text: "and the label" }),
    message({ kind: "worker_report", summary: "not recalled" }),
  ];
  assert.equal(syntheticRecallQuery(messages, POLICY, worker), "fix the button\n\nand the label");
  assert.equal(syntheticRecallQuery([message("not json")], POLICY, worker), "");
  assert.equal(syntheticRecallQuery([message({ kind: "worker_report", text: "x" })], POLICY, worker), "");
});

test("worker assignment recall uses only the first assignment with a string text", () => {
  const first = message({ ticket_id: "t1", title: "Fix it", assignment: "Change the label", trigger: { text: "please fix" } });
  const later = message({ ticket_id: "t1", assignment: 2, note: "continue" });
  assert.equal(syntheticRecallQuery([first, later], POLICY, worker), "Fix it\nChange the label\nplease fix");
  assert.equal(syntheticRecallQuery([later], POLICY, worker), "");
  const second = message({ ticket_id: "t2", title: "Second", assignment: "Do not use", trigger: { text: "later" } });
  assert.equal(syntheticRecallQuery([first, second], POLICY, worker), "Fix it\nChange the label\nplease fix");
  const resumed = message({ ticket_id: "t3", title: "Resumed", trigger: { text: "continue the work" } });
  assert.equal(syntheticRecallQuery([resumed], POLICY, worker), "Resumed\ncontinue the work");
});

test("worker follow-up trigger cards contribute only addressed human text", () => {
  const followUp = message({ trigger_id: "t1", from: "ou_x", text: "also update the label" });
  assert.equal(syntheticRecallQuery([followUp], POLICY, worker), "also update the label");
  assert.equal(syntheticRecallQuery([message({ trigger_id: "t1", from: "", text: "CI passed 0/0" })], POLICY, worker), "");
  assert.equal(syntheticRecallQuery([message({ trigger_id: "t1", from: "ou_x", text: "context only", context: true })], POLICY, worker), "");
  assert.equal(syntheticRecallQuery([message({ trigger_id: "t1", from: "ou_x", text: "   " })], POLICY, worker), "");
  assert.equal(syntheticRecallQuery([message({ trigger_id: "t1", text: "no author" })], POLICY, worker), "");
  const report = message({ kind: "worker_report", ticket: { ticket_id: "t1" }, trigger_id: "t2", state: "ready", summary: "done" });
  assert.equal(syntheticRecallQuery([report], POLICY, worker), "");
  const assignment = message({ ticket_id: "t3", title: "Fix", trigger: { text: "please fix" } });
  assert.equal(syntheticRecallQuery([assignment, followUp], POLICY, worker), "Fix\nplease fix\n\nalso update the label");
});

test("loads a policy from the exact instance file and has no fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-"));
  try {
    assert.equal(loadSyntheticPolicy(dir), EMPTY_POLICY);
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    assert.deepEqual(loadSyntheticPolicy(dir), POLICY);

    await writeFile(join(dir, "ov-memory-policy.json"), "{bad json");
    assert.equal(loadSyntheticPolicy(dir), EMPTY_POLICY);

    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify({ version: 2, recall: [], capture: [] }));
    assert.equal(loadSyntheticPolicy(dir), EMPTY_POLICY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects fail-open selectors and unsupported capture selectors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-invalid-"));
  try {
    const invalid = [
      { version: 1, recall: [{ match: {} }], capture: [] },
      { version: 1, recall: [{ match: { sorce: { kind: "dsh-superagent" } } }], capture: [] },
      { version: 1, recall: [], capture: [{ match: { session: { agentPreset: "x" } } }] },
      { version: 1, recall: [{ match: { body: { has: [] } } }], capture: [] },
    ];
    for (const value of invalid) {
      await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(value));
      assert.equal(loadSyntheticPolicy(dir), EMPTY_POLICY, JSON.stringify(value));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime re-resolves stateDir after the orchestrator becomes available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-late-"));
  try {
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    let stateDir = "";
    const writes = [];
    const runtime = new OpenVikingRuntime({
      async addMessage(_sessionId, payload) { writes.push(payload); return { ok: true }; },
    }, { captureAssistantTurns: true, captureToolResults: true, captureMaxLength: 24000, captureMode: "semantic" }, { debug() {} }, null, () => stateDir);
    const session = { id: "late-router", header: { cwd: "/workspace" } };
    const state = runtime.stateFor(session);
    assert.equal(state.stateDir, "");
    state.ready = true;
    stateDir = dir;
    runtime.capture(session, { type: "user/message", data: message({ kind: "candidate", text: "late" }) });
    await runtime.flush(session);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].parts[0].text, JSON.stringify({ kind: "candidate", text: "late" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall merges human prompt text with the synthetic query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-recall-"));
  try {
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    const bodies = [];
    const base = { minQueryLength: 1, captureAssistantTurns: true, captureToolResults: false, captureMode: "semantic" };
    const runtime = new OpenVikingRuntime({
      async fetchJSON(path, init) {
        if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
        return { ok: true, result: { context: "<openviking-context>recalled</openviking-context>", stats: {} } };
      },
    }, base, { debug() {} }, null, () => dir);
    runtime.initialize = async () => ({ ready: true, stateDir: dir, config: { ...base, syntheticPolicy: POLICY } });
    const human = { role: "user", content: [{ type: "text", text: "human question" }], source: { kind: "user" } };
    await runtime.recallMessage({ session: { header: { agentPreset: "dsh-superagent-router" } } }, [human, message({ kind: "candidate", text: "synthetic request" })]);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].query, /human question/);
    assert.match(bodies[0].query, /synthetic request/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker follow-up trigger cards reach recall, but context-only and authorless cards do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-followup-"));
  try {
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    const bodies = [];
    const base = { minQueryLength: 1, captureAssistantTurns: true, captureToolResults: false, captureMode: "semantic" };
    const runtime = new OpenVikingRuntime({
      async fetchJSON(path, init) {
        if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
        return { ok: true, result: { context: "<openviking-context>recalled</openviking-context>", stats: {} } };
      },
    }, base, { debug() {} }, null, () => dir);
    runtime.initialize = async () => ({ ready: true, stateDir: dir, config: { ...base, syntheticPolicy: POLICY } });
    const agent = { session: { header: { agentPreset: "dsh-superagent-worker" } } };

    await runtime.recallMessage(agent, [message({ trigger_id: "t1", from: "ou_x", text: "also update the label" })]);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].query, "also update the label");

    bodies.length = 0;
    await runtime.recallMessage(agent, [message({ trigger_id: "t2", from: "", text: "CI passed 0/0" })]);
    await runtime.recallMessage(agent, [message({ trigger_id: "t3", from: "ou_x", text: "context only", context: true })]);
    assert.equal(bodies.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store reloads after the instance policy file changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-store-"));
  try {
    const store = new SyntheticPolicyStore({ warn() {} });
    assert.equal(store.get(dir), EMPTY_POLICY);
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    assert.equal(store.get(dir).capture.length, 1);
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify({ ...POLICY, capture: [] }));
    assert.equal(store.get(dir).capture.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureEvent captures a source kind allowed by the policy", () => {
  const config = {
    captureAssistantTurns: true,
    captureToolResults: true,
    captureToolMaxChars: 1000000,
    captureMaxLength: 24000,
    captureMode: "semantic",
    peerId: "p",
    syntheticPolicy: POLICY,
  };
  const event = { type: "user/message", data: message({ kind: "candidate", text: "hello" }) };
  const captured = captureEvent(event, config);
  assert.equal(captured.role, "user");
  assert.equal(captured.parts[0].text, JSON.stringify({ kind: "candidate", text: "hello" }));
  assert.equal(captured.peer_id, "p");
  assert.equal(captureEvent(event, { ...config, syntheticPolicy: EMPTY_POLICY }), null);
});

test("runtime reads the exact instance policy and has no cwd fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-runtime-"));
  try {
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    const runtime = new OpenVikingRuntime({}, {}, { debug() {} }, null, () => dir);
    const state = runtime.stateFor({ id: "session", header: { cwd: "/workspace" } });
    assert.equal(state.stateDir, dir);
    assert.equal(state.config.syntheticPolicy.capture.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime capture follows the instance policy and stores the raw text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-policy-capture-"));
  try {
    await writeFile(join(dir, "ov-memory-policy.json"), JSON.stringify(POLICY));
    const writes = [];
    const runtime = new OpenVikingRuntime({
      async addMessage(_sessionId, payload) {
        writes.push(payload);
        return { ok: true };
      },
    }, {
      captureAssistantTurns: true,
      captureToolResults: true,
      captureToolMaxChars: 1000000,
      captureMaxLength: 24000,
      captureMode: "semantic",
    }, { debug() {} }, null, () => dir);
    const session = { id: "synthetic-capture", header: { cwd: "/workspace" } };
    runtime.stateFor(session).ready = true;

    runtime.capture(session, { type: "user/message", data: message({ kind: "candidate", text: "hello" }) });
    await runtime.flush(session);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].parts[0].text, JSON.stringify({ kind: "candidate", text: "hello" }));

    runtime.capture(session, { type: "user/message", data: message("not json") });
    await runtime.flush(session);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].parts[0].text, "not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
