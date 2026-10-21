// Test-only commands: no model calls or tools. Loaded ONLY by integration tests.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// A compiled Pi (e.g. mise's aqua build) is its own execPath; only an npm Pi runs on node.
const node = /\/node$/.test(process.execPath) ? process.execPath : "node";
export default function(pi: ExtensionAPI) {
  pi.registerCommand("fixture-name", {
    description: "Test only: supported native rename/clear without model requests",
    handler: async (args) => { pi.setSessionName(args); }
  });
  pi.registerCommand("fixture-legacy-status", {
    description: "Test only: simulate previous registrar footer before isolated reload",
    handler: async (_args, ctx) => { ctx.ui.setStatus("tmux-continuity", "tmux-legacy-marker · registered · NON-RESTORABLE"); }
  });
  pi.registerCommand("fixture-prompt", {
    description: "Test only: native blocking UI prompt without a model request",
    handler: async (_args, ctx) => { await ctx.ui.confirm("Fixture attention probe", "Offline test only"); }
  });
  pi.registerCommand("fixture-background", {
    description: "Test only: attempt inherited-terminal background claim",
    handler: async (output, _ctx) => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [fileURLToPath(new URL("./claim.js", import.meta.url)), output],
          { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error("claim child failed")));
      });
    }
  });
  pi.registerCommand("fixture-rpc", {
    description: "Test only: real headless Pi with inherited tmux variables",
    handler: async (output, _ctx) => {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        const child = spawn("pi", ["--offline", "--mode", "rpc", "--no-session",
          "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
          "--no-prompt-templates", "--no-themes", "--no-approve",
          "-e", resolve(fileURLToPath(new URL("../..", import.meta.url)))], { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", resolveExit);
      });
      writeFileSync(output, JSON.stringify({ code }));
    }
  });
  pi.registerCommand("fixture-resume", {
    description: "Test only: resume exact fixture",
    handler: async (path, ctx) => { await ctx.switchSession(path); }
  });
  pi.registerCommand("fixture-fork", {
    description: "Test only: fork a user entry",
    handler: async (_args, ctx) => {
      const entry = ctx.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user");
      if (!entry) throw new Error("Missing fixture user entry");
      await ctx.fork(entry.id, { position: "at" });
    }
  });
}
