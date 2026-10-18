#!/usr/bin/env node
import { handleHook } from "../src/claude.js";

// Bounded input, no raw payload logging, silent success even on operational
// failure. Stdout must stay empty: SessionStart/UserPromptSubmit stdout is context.
try {
  if (process.argv.length === 4 && process.argv[2] === "--claude-bin") {
    let length = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1024 * 1024) { chunks.length = 0; break; }
      chunks.push(chunk);
    }
    if (chunks.length) handleHook(JSON.parse(Buffer.concat(chunks).toString("utf8")), process.argv[3]);
  }
} catch { /* Never block a prompt, tool call, or shutdown. Inspect to diagnose. */ }
