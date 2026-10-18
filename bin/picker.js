#!/usr/bin/env node
// Internal keybinding entry point, not a new user-facing command or launcher.
import { openPopup, decodeContext, pick } from "../src/picker.js";
try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "open" && args.length === 6 && args[0] === "--socket" && args[2] === "--client" && args[4] === "--client-pid") {
    openPopup(args[1], args[3], args[5]);
  } else if (mode === "pick" && args.length === 2 && args[0] === "--context") {
    pick(decodeContext(args[1]));
  } else throw new Error("Invalid internal picker arguments");
} catch {
  // Never echo untrusted exception text, labels, socket paths or metadata.
  console.error("Live-agent picker refused: target/client changed, unavailable, or picker failed. Reopen to refresh.");
  process.exitCode = 1;
}
