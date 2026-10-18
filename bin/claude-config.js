#!/usr/bin/env node
import { proposeHooks } from "../src/claude.js";

// Dry run ONLY. Existing settings are optional stdin; never open user settings.
try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node bin/claude-config.js --claude-bin /absolute/native/claude [--merge-stdin]\nPrint a JSON proposal only; never reads/writes user settings. Exec-form hooks require a current Claude Code CLI.");
  } else {
    if (args[0] !== "--claude-bin" || !args[1] || args.length > 3 || (args[2] && args[2] !== "--merge-stdin")) throw new Error("See --help");
    let settings = {};
    if (args[2]) {
      let raw = "";
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (raw.length > 1024 * 1024) throw new Error("Settings input too large");
      }
      settings = JSON.parse(raw);
    }
    console.log(JSON.stringify(proposeHooks(settings, args[1]), null, 2));
  }
} catch {
  console.error("pi-tmux-continuity: invalid proposal input (no files changed)");
  process.exitCode = 1;
}
