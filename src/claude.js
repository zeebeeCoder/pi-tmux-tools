import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { sessionName } from "./presentation.js";
import { ownership, sameProcess, choose } from "./logic.js";
import { EVENT_PREFIX, unknown, activityFor, sameScope, claudeName } from "./activity.js";
import { socketFromEnv, observePane, processesFor, readRecords, readEvents, publish, materialize, tmux } from "./runtime.js";

export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure"];
const path = s => typeof s === "string" && isAbsolute(s) && !s.includes("\0") && s.length < 8192;
const id = s => typeof s === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(s);
// Allowlist fields; bodies, prompts, permission content and environments are discarded.
export function hookInput(input) {
  if (!input || input.agent_id || input.hook_event_name?.startsWith("Subagent") ||
      !HOOK_EVENTS.includes(input.hook_event_name) || !id(input.session_id) ||
      !path(input.transcript_path) || !path(input.cwd)) return null;
  if (input.hook_event_name === "SessionStart" && !["startup", "resume", "clear", "compact", "fork"].includes(input.source)) return null;
  return {
    event: input.hook_event_name, sessionId: input.session_id, sessionFile: input.transcript_path,
    // Only these events document a custom conversation title. In particular,
    // Notification.title is NOT a session name; generated/tmux titles are ignored.
    ...( ["SessionStart", "UserPromptSubmit"].includes(input.hook_event_name)
      ? { sessionName: sessionName(input.session_title), sessionNameSource: "claude-hook" } : {} ),
    cwd: input.cwd, source: input.hook_event_name === "SessionStart" ? input.source : null,
    promptId: id(input.prompt_id) ? input.prompt_id : null,
    notification: ["permission_prompt", "idle_prompt"].includes(input.notification_type) ? input.notification_type : null
  };
}
export function claudeProbe(pid, executable, tty) {
  const helper = fileURLToPath(new URL("./claude-owner.py", import.meta.url));
  return JSON.parse(execFileSync("python3", [helper, String(pid), executable, tty], {
    encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
  }));
}
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 32);
function displayOptions(socket, pane, options) {
  return { ...options, derive: r => {
    const observed = readEvents(socket, pane);
    const ended = observed.events.some(e => sameScope(r, e) && e.event === "SessionEnd" && BigInt(e.order) > BigInt(r.generation));
    return { ...r, ...claudeName(r, observed.events), state: ended ? "closed" : r.state, activity: activityFor(r, observed.events, observed.errors) };
  } };
}
// Native command-hook adapter; never emits a Claude decision, context or prompt.
export function handleHook(input, executable, env = process.env) {
  const data = hookInput(input);
  if (!data || !path(executable)) return { reason: "unsupported hook or native executable path" };
  const socket = socketFromEnv(env), pane = env.TMUX_PANE;
  if (!socket || !pane) return { reason: "outside tmux" };
  const current = observePane(socket, pane);
  const probe = claudeProbe(process.pid, executable, current.tty);
  if (!probe.owner) return { reason: probe.reason };
  const ps = processesFor([probe.owner.pid, current.root.pid]);
  if (!sameProcess(probe.owner, ps[probe.owner.pid])) return { reason: "owner changed" };
  const problem = ownership(ps[probe.owner.pid], current.root, ps, true);
  if (problem) return { reason: problem };
  const token = hash(JSON.stringify([probe.owner.pid, probe.owner.birth, probe.invocation.pid, probe.invocation.birth]));
  if (data.event === "SessionStart") {
    const record = {
      version: 1, agent: "claude", owner: token, generation: probe.order,
      // Native source=fork also describes background copies and /branch. Until
      // foreground destination is verifiable, install a closed-generation barrier
      // instead of attributing that possibly-background conversation to the pane.
      state: data.source === "fork" ? "closed" : "active",
      registrationReason: data.source === "fork" ? "ambiguous Claude fork destination; resume the foreground conversation to re-register" : null,
      socket: current.socket, pane, tty: current.tty, server: current.server, root: current.root, process: probe.owner,
      cwd: data.cwd, sessionId: data.sessionId, sessionFile: data.sessionFile,
      sessionName: data.sessionName, sessionNameSource: data.sessionNameSource,
      activity: { ...unknown("Claude SessionStart; turn state not established"), observedAt: new Date().toISOString() }
    };
    publish(record, displayOptions(socket, pane, { activation: true }));
    return { registered: record.state === "active", reason: record.registrationReason };
  }
  const { records, errors } = readRecords(socket, pane);
  const selected = choose(records, current, ps);
  const record = selected.record;
  if (errors.length || selected.reason || record?.agent !== "claude" ||
      record.sessionId !== data.sessionId || record.sessionFile !== data.sessionFile ||
      BigInt(probe.order) <= BigInt(record.generation)) return { reason: "stale, missing, or uncertain activation" };
  // Each native invocation owns its own slot; delayed writes cannot replace newer
  // events or registrations. Inspection reduces only this exact owner/session.
  const event = {
    version: 1, id: token, owner: record.owner, generation: record.generation,
    sessionId: record.sessionId, sessionFile: record.sessionFile,
    event: data.event, promptId: data.promptId, notification: data.notification,
    ...(data.event === "UserPromptSubmit" ? { sessionName: data.sessionName, sessionNameSource: data.sessionNameSource } : {}),
    order: probe.order, observedAt: new Date().toISOString()
  };
  tmux(socket, ["set-option", "-p", "-t", pane, EVENT_PREFIX + token, JSON.stringify(event)]);
  materialize(record, displayOptions(socket, pane, { eventOnly: true }));
  return { observed: true };
}

export function proposeHooks(settings, executable, node = process.execPath) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !path(executable) || !path(node)) throw new Error("Expected settings object and absolute executable paths");
  const result = structuredClone(settings);
  if (result.hooks === undefined) result.hooks = {};
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) throw new Error("hooks must be an object");
  const script = fileURLToPath(new URL("../bin/claude-hook.js", import.meta.url));
  const command = { type: "command", command: node, args: [script, "--claude-bin", executable], timeout: 10 };
  for (const event of HOOK_EVENTS) {
    if (result.hooks[event] === undefined) result.hooks[event] = [];
    const entries = result.hooks[event];
    if (!Array.isArray(entries)) throw new Error(event + " hooks must be an array");
    if (!entries.some(e => e && [undefined, "", "*"].includes(e.matcher) && e.hooks?.some(h =>
      h?.type === command.type && h.command === command.command && h.timeout === command.timeout &&
      h.async !== true && h.asyncRewake !== true && JSON.stringify(h.args) === JSON.stringify(command.args)))) {
      entries.push({ hooks: [structuredClone(command)] });
    }
  }
  return result;
}
