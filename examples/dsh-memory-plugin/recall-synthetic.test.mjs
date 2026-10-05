/**
 * Regression tests for synthetic-injection handling in the recall path.
 *
 * Two independent defects, same root cause (the "is this message human?" predicate is
 * applied in capture but not in recall):
 *
 *   A. the recall QUERY is built from every non-OpenViking message, so harness-injected
 *      context (time-context, goal, runtime-context, plugin notices …) dilutes it;
 *   B. recall TRIGGERS on any step that claimed messages, even when none of them came
 *      from the human (e.g. a step started by a plugin injecting a skill body).
 *
 * Measured on a real dsh session before the fix: 76% of the query text was synthetic
 * injection, and 272 of 1,778 non-human steps still triggered a recall.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "./index.mjs";

/** A human message (the shape dsh produces). */
function human(text) {
  return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/** A synthetic context producer — exactly how dsh v4 tags them (see capture.mjs). */
function synthetic(text, kind = "time-context") {
  return { role: "user", content: [{ type: "text", text }], source: { kind } };
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify({
    status: status < 400 ? "ok" : "error",
    ...(status < 400 ? { result } : { error: { code: "NOT_FOUND" } }),
  }), { status, headers: { "Content-Type": "application/json" } });
}

/** Mount the plugin and capture every recall query it sends. */
function mount(config = {}) {
  const handlers = new Map();
  let runtime;
  const ctx = {
    logger: { debug() {} },
    provide(name, value) {
      if (name === "openvikingMemory") runtime = value;
    },
    effect(execute) {
      execute();
      return async () => {};
    },
    tools: { register() {} },
    plugin() {},
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  apply(ctx, { endpoint: "http://127.0.0.1:1933", workspacePeer: false, ...config });
  runtime?.stopDrainer?.();
  if (runtime) {
    runtime.initializeState = async (state) => {
      state.profileBlock = "";
      state.ready = true;
    };
  }

  const queries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/search/search") {
      const body = JSON.parse(init.body);
      queries.push(body.query);
      return jsonResponse({ rendered: "" });
    }
    if (path === "/health" || path === "/api/v1/sessions" || path === "/api/v1/fs/ls") {
      return jsonResponse(path === "/api/v1/fs/ls" ? [] : {});
    }
    return jsonResponse({}, 404);
  };

  const agent = {
    session: { id: `synthetic-${Math.random().toString(36).slice(2)}`, header: { cwd: "/workspace" } },
    ctx: { effect(execute) { execute(); return async () => {}; } },
  };
  if (handlers.has("agent/created")) handlers.get("agent/created")({ agent, source: "startup" });

  return {
    queries,
    async preStep(messages) {
      return handlers.get("agent/pre-step")(
        { agent, messages, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages }),
      );
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("A: recall query must not include synthetic context messages", async () => {
  const h = mount({ recallQueryHumanOnly: true });
  try {
    await h.preStep([
      human("数据库连接池该怎么配"),
      synthetic("Time sampled while preparing turn 12, step 3: 2026-10-05T21:00:00+08:00 [Asia/Shanghai]"),
    ]);
    assert.equal(h.queries.length, 1, "expected exactly one recall request");
    assert.equal(h.queries[0], "数据库连接池该怎么配",
      "the recall query must be the human text alone, not the harness boilerplate");
  } finally {
    h.restore();
  }
});

test("A': with the switch off the legacy behaviour is preserved", async () => {
  const h = mount();
  try {
    await h.preStep([human("A"), synthetic("B")]);
    assert.equal(h.queries.length, 1);
    assert.match(h.queries[0], /A/, "human text still present");
    assert.match(h.queries[0], /B/, "legacy default keeps synthetic text in the query");
  } finally {
    h.restore();
  }
});

test("B: a step claimed by plugin injections alone must not recall", async () => {
  const h = mount({ recallHumanTriggeredOnly: true });
  try {
    const decision = await h.preStep([synthetic("<skill_content name=\"x\">…</skill_content>", "skill-invocation")]);
    assert.equal(h.queries.length, 0, "no human message in this step ⇒ no recall");
    assert.ok(decision && Array.isArray(decision.messages), "pre-step must still return a valid decision");
  } finally {
    h.restore();
  }
});

test("B': a step triggered by a human message recalls even when synthetic context rides along", async () => {
  const h = mount({ recallHumanTriggeredOnly: true });
  try {
    await h.preStep([human("帮我看下这个问题"), synthetic("goal: round 12")]);
    assert.equal(h.queries.length, 1, "a human-triggered step must still recall");
  } finally {
    h.restore();
  }
});

test("B'': switching the guard off keeps legacy triggering", async () => {
  const h = mount();
  try {
    await h.preStep([synthetic("goal: round 12", "goal")]);
    assert.equal(h.queries.length, 1, "legacy default retains the old trigger");
  } finally {
    h.restore();
  }
});
