import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquire, close, persistence, publish } from "./runtime.js";
import { transition } from "./activity.js";
import { sessionName } from "./presentation.js";

// Dependency seam is for offline adapter tests. Default uses only public Pi APIs.
export function attach(pi: ExtensionAPI, ops = { acquire, close, persistence, publish }) {
  let record: ReturnType<typeof acquire>["record"];
  let sequence = 0, prompts = 0;
  const clearLegacyStatus = (ctx: ExtensionContext) => {
    try {
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setStatus("tmux-continuity", undefined);
    } catch { /* Only clear the previous version's footer; never add status text. */ }
  };
  const stop = () => {
    const previous = record;
    record = undefined;
    prompts = 0;
    try { if (previous) ops.close(previous); } catch { /* Cleanup cannot block a new claim. */ }
  };
  const matches = (ctx: ExtensionContext) => record && ctx.mode === "tui" && ctx.hasUI &&
    ctx.sessionManager.getSessionId() === record.sessionId &&
    (ctx.sessionManager.getSessionFile() ?? null) === record.sessionFile;
  // Read current API state, not the rename event payload: an async-dispatched
  // old payload must never name a different current conversation.
  const currentName = () => {
    try { return sessionName(pi.getSessionName?.()); } catch { return null; }
  };
  const observe = (ctx: ExtensionContext, state: string, reason: string) => {
    try {
      if (!matches(ctx) || !record) return;
      const observed = transition(record, { ...record, sequence: String(++sequence),
        activity: { state, reason, observedAt: new Date().toISOString() } });
      const next = { ...observed, sessionName: currentName(), sessionNameSource: "pi-api" };
      ops.publish(next);
      record = next;
    } catch { /* Registration/activity is silent; inspect on demand. */ }
  };
  pi.on("session_start", (_event, ctx) => {
    clearLegacyStatus(ctx);
    try {
      stop();
      if (ctx.signal?.aborted) return;
      const result = ops.acquire({
        mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(), sessionName: currentName()
      });
      record = result.record;
    } catch { /* Fail-open and silent. Use /tmux-binding or the inspector. */ }
  });
  pi.on("session_shutdown", () => { stop(); });
  pi.on("session_info_changed", (_event, ctx) => {
    try {
      if (!matches(ctx) || !record) return;
      const next = { ...record, sessionName: currentName(), sessionNameSource: "pi-api",
        activitySequence: String(++sequence) };
      ops.publish(next);
      record = next; // Rename changes metadata, NOT last activity observation time.
    } catch { /* Silent and fail-open, like other observations. */ }
  });
  pi.on("agent_start", (_event, ctx) => {
    observe(ctx, prompts ? "needs-attention" : "working", "Pi agent_start");
  });
  pi.on("turn_start", (_event, ctx) => {
    observe(ctx, prompts ? "needs-attention" : "working", "Pi turn_start (including continuation)");
  });
  // agent_end can precede retry/compaction/queued continuation. Ignore it.
  pi.on("agent_end", () => {});
  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (prompts) observe(ctx, "needs-attention", "Pi blocking UI prompt remains open");
      else if (ctx.isIdle() && !ctx.hasPendingMessages()) observe(ctx, "idle", "Pi agent_settled + idle check (not work acceptance)");
      else observe(ctx, "unknown", "Pi settlement contradicted by active or pending work");
    } catch { observe(ctx, "unknown", "Pi idle check unavailable"); }
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    try {
      if (!matches(ctx)) return;
      prompts++;
      observe(ctx, "needs-attention", "Pi native blocking UI prompt (not necessarily permission)");
    } catch { /* Fail-open. */ }
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    try {
      if (!matches(ctx)) return;
      if (!prompts) { observe(ctx, "unknown", "unmatched Pi UI prompt end"); return; }
      prompts--;
      observe(ctx, prompts ? "needs-attention" : (ctx.isIdle() ? "unknown" : "working"),
        prompts ? "Pi blocking UI prompt remains open" : "Pi UI prompt closed; settlement not implied");
    } catch { observe(ctx, "unknown", "Pi UI prompt state unavailable"); }
  });
  pi.registerCommand("tmux-binding", {
    description: "Show this instance's exact tmux binding and activity (no model request)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      try {
        const message = record
          ? JSON.stringify({ agent: "pi", owner: record.owner, generation: record.generation,
              pane: record.pane, socket: record.socket, cwd: record.cwd,
              sessionFile: record.sessionFile, sessionId: record.sessionId,
              sessionName: record.sessionName, sessionNameSource: record.sessionNameSource,
              activity: record.activity, ...ops.persistence(record) })
          : "No binding: outside tmux, not foreground TUI owner, or registration failed. Use the standalone inspector for live validity.";
        ctx.ui.notify(message, "info");
      } catch { /* Inspection must not interrupt interaction either. */ }
    }
  });
}
export default function (pi: ExtensionAPI) { attach(pi); }
