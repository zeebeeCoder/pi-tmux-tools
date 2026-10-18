import { writeFileSync } from "node:fs";
import { acquire } from "../../src/runtime.js";
const result = acquire({ mode: "tui", hasUI: true, cwd: process.cwd(), sessionId: "background", sessionFile: null });
writeFileSync(process.argv[2], JSON.stringify({ reason: result.reason, claimed: Boolean(result.record) }));
