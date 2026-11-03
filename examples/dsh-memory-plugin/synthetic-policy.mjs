import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const POLICY_FILE = "ov-memory-policy.json";
export const EMPTY_POLICY = Object.freeze({ version: 1, recall: [], capture: [] });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageText(message) {
  for (const part of message?.content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") return part.text;
  }
  return "";
}

export function messageBody(message) {
  const text = messageText(message);
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasAll(body, names) {
  if (!isObject(body) || !Array.isArray(names)) return false;
  return names.every(name => Object.hasOwn(body, name));
}

export function matchesRule(rule, message, body, session) {
  const match = rule?.match;
  if (!isObject(match)) return false;

  if (isObject(match.source)) {
    if (match.source.kind !== undefined && message?.source?.kind !== match.source.kind) return false;
    if (match.source.form !== undefined && message?.source?.form !== match.source.form) return false;
  }

  if (isObject(match.session) && match.session.agentPreset !== undefined
    && session?.header?.agentPreset !== match.session.agentPreset) return false;

  if (isObject(match.body)) {
    if (!isObject(body)) return false;
    if (match.body.kind !== undefined && body.kind !== match.body.kind) return false;
    if (match.body.has !== undefined && !hasAll(body, match.body.has)) return false;
  }

  return true;
}

export function captureAllowed(policy, message) {
  return (policy?.capture ?? []).some(rule => matchesRule(rule, message, null, null));
}

export function syntheticRecallQuery(messages, policy, session) {
  if (!policy?.recall?.length) return "";
  const queries = [];
  let workerAssignmentSeen = false;
  for (const message of messages ?? []) {
    const body = messageBody(message);
    if (!body) continue;
    const matched = (policy?.recall ?? []).some(rule => matchesRule(rule, message, body, session));
    if (!matched) continue;
    if (body.kind === "candidate" || body.kind === "follow_up") {
      if (typeof body.text === "string" && body.text.trim()) queries.push(body.text.trim());
      continue;
    }
    // A worker follow-up is a trigger card, not an assignment: it carries
    // trigger_id and text, but no ticket_id. Context-only cards are not
    // addressed to the ticket, and a card with no author (`from: ""`) is an
    // automated notice such as a GitHub CI result; neither is a recall query.
    if (typeof body.trigger_id === "string" && typeof body.text === "string") {
      const text = body.text.trim();
      const author = typeof body.from === "string" ? body.from.trim() : "";
      if (text && author && body.context !== true) queries.push(text);
      continue;
    }
    if (typeof body.ticket_id === "string") {
      const assignment = typeof body.assignment === "string" ? body.assignment.trim() : "";
      const triggerText = typeof body.trigger?.text === "string" ? body.trigger.text.trim() : "";
      if (!assignment && !triggerText) continue;
      if (workerAssignmentSeen) continue;
      workerAssignmentSeen = true;
      const parts = [];
      if (typeof body.title === "string" && body.title.trim()) parts.push(body.title.trim());
      if (assignment) parts.push(assignment);
      if (triggerText) parts.push(triggerText);
      if (parts.length) queries.push(parts.join("\n"));
    }
  }
  return queries.join("\n\n").trim();
}

const MATCH_KEYS = new Set(["source", "session", "body"]);
const SOURCE_KEYS = new Set(["kind", "form"]);
const BODY_KEYS = new Set(["kind", "has"]);
const SESSION_KEYS = new Set(["agentPreset"]);

function noUnknownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(where + " has unknown key " + key);
  }
}

function validateSelector(match, where, captureOnly) {
  if (!isObject(match)) throw new Error(where + " must contain a match object");
  if (Object.keys(match).length === 0) throw new Error(where + " match must not be empty");
  noUnknownKeys(match, MATCH_KEYS, where + " match");
  if (captureOnly && Object.keys(match).some(key => key !== "source")) {
    throw new Error(where + " capture rules may only match source");
  }
  if (match.source !== undefined) {
    if (!isObject(match.source) || Object.keys(match.source).length === 0) {
      throw new Error(where + " source must be a non-empty object");
    }
    noUnknownKeys(match.source, SOURCE_KEYS, where + " source");
    for (const key of ["kind", "form"]) {
      if (match.source[key] !== undefined && typeof match.source[key] !== "string") {
        throw new Error(where + " source." + key + " must be a string");
      }
    }
  }
  if (match.session !== undefined) {
    if (!isObject(match.session) || Object.keys(match.session).length === 0) {
      throw new Error(where + " session must be a non-empty object");
    }
    noUnknownKeys(match.session, SESSION_KEYS, where + " session");
    if (typeof match.session.agentPreset !== "string") {
      throw new Error(where + " session.agentPreset must be a string");
    }
  }
  if (match.body !== undefined) {
    if (!isObject(match.body) || Object.keys(match.body).length === 0) {
      throw new Error(where + " body must be a non-empty object");
    }
    noUnknownKeys(match.body, BODY_KEYS, where + " body");
    if (match.body.kind !== undefined && typeof match.body.kind !== "string") {
      throw new Error(where + " body.kind must be a string");
    }
    if (match.body.has !== undefined
      && (!Array.isArray(match.body.has) || match.body.has.length === 0
        || !match.body.has.every(name => typeof name === "string"))) {
      throw new Error(where + " body.has must be a non-empty string array");
    }
  }
}

function validatePolicy(value) {
  if (!isObject(value)) throw new Error("policy must be a JSON object");
  if (value.version !== 1) throw new Error("unsupported policy version");
  for (const name of ["recall", "capture"]) {
    if (!Array.isArray(value[name])) throw new Error(name + " must be an array");
    value[name].forEach((rule, index) => {
      if (!isObject(rule) || Object.keys(rule).length !== 1 || !isObject(rule.match)) {
        throw new Error(name + "[" + index + "] must contain exactly one match object");
      }
      validateSelector(rule.match, name + "[" + index + "]", name === "capture");
    });
  }
  return { version: 1, recall: value.recall, capture: value.capture };
}

export function loadSyntheticPolicy(stateDir, logger = console) {
  if (!stateDir) return EMPTY_POLICY;
  const path = join(stateDir, POLICY_FILE);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.("OpenViking: cannot read " + path + ": " + String(error));
    return EMPTY_POLICY;
  }
  try {
    return validatePolicy(JSON.parse(text));
  } catch (error) {
    logger?.warn?.("OpenViking: ignoring invalid " + path + ": " + String(error));
    return EMPTY_POLICY;
  }
}

export class SyntheticPolicyStore {
  constructor(logger = console) {
    this.logger = logger;
    this.cache = new Map();
  }

  get(stateDir) {
    if (!stateDir) return EMPTY_POLICY;
    const path = join(stateDir, POLICY_FILE);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return EMPTY_POLICY;
    }
    const previous = this.cache.get(path);
    if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return previous.value;
    const value = loadSyntheticPolicy(stateDir, this.logger);
    this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
}
