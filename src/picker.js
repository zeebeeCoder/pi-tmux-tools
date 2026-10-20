import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readDisplay, validateTarget, processesFor, tmux } from "./runtime.js";
import { sameProcess, validProcess } from "./logic.js";
import { STATES } from "./activity.js";
import { label, folders, columns, columnLine, heading, relativeAge, DOT_COLORS } from "./presentation.js";
export { label } from "./presentation.js";
import { SORTS, nextSort, previousSort, namedSession, sortRows } from "./picker-sort.js";

// Fixed absolute locations only (Homebrew, then distribution packages); never PATH.
const FZF_PATHS = ["/opt/homebrew/bin/fzf", "/usr/local/bin/fzf", "/usr/bin/fzf"];
export const FZF = FZF_PATHS.find(p => existsSync(p)) ?? FZF_PATHS[0];
const cli = fileURLToPath(new URL("../bin/picker.js", import.meta.url));
const clientPattern = /^\/dev\/[A-Za-z0-9_./-]+$/;
export const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export function sameTarget(a, b) {
  return Boolean(a && b && a.state === "active" && b.state === "active" &&
    (a.agent ?? "pi") === (b.agent ?? "pi") && a.socket === b.socket && a.pane === b.pane &&
    a.tty === b.tty && sameProcess(a.server, b.server) && sameProcess(a.root, b.root) &&
    sameProcess(a.process, b.process) && a.owner === b.owner && a.generation === b.generation &&
    a.sessionId === b.sessionId && a.sessionFile === b.sessionFile);
}
export function makeChoices(rows, { terminalWidth = 80, now = Date.now(), sort = 'Recent' } = {}) {
  const choices = new Map(), seen = new Set();
  const active = sortRows(rows.filter(row => {
    const b = row.binding;
    if (!b || b.state !== "active" || seen.has(b.pane)) return false;
    seen.add(b.pane); return true;
  }), sort, now);
  const shortFolders = folders(active.map(row => row.binding.cwd));
  const sizes = columns(terminalWidth);
  choices.heading = heading(sizes);
  choices.sort = SORTS.includes(sort) ? sort : 'Recent';
  for (const [i, row] of active.entries()) {
    const b = row.binding;
    const token = randomBytes(16).toString("hex");
    const activity = STATES.includes(row.activity?.state) ? row.activity.state : "unknown";
    const agent = b.agent === "claude" ? "claude" : "pi";
    let name = namedSession(b) ? label(b.sessionName) : "Unnamed";
    const peers = active.filter((r, j) => !namedSession(r.binding) && (r.binding.agent ?? "pi") === agent && shortFolders[j] === shortFolders[i]);
    if (!namedSession(b) && peers.length > 1) {
      let length = 6;
      while (length < 12 && peers.some(r => r !== row && r.binding.sessionId.slice(0, length) === b.sessionId.slice(0, length))) length++;
      const duplicate = peers.some(r => r !== row && r.binding.sessionId.slice(0, length) === b.sessionId.slice(0, length));
      name += " " + label(duplicate ? b.owner.slice(0, 6) : b.sessionId.slice(0, length), length);
    }
    const visible = columnLine(["●", agent, name, shortFolders[i], relativeAge(row.activity?.observedAt, now)], sizes);
    // fzf --ansi strips SGR on output. Validate that exact plain line, not a
    // color-stripped approximation of arbitrary returned bytes. Token stays hidden.
    const line = token + "\t" + visible;
    const inputLine = token + "\t\x1b[" + DOT_COLORS[activity] + "m●\x1b[0m" + visible.slice(1);
    choices.set(token, { line, inputLine, binding: b });
  }
  return choices;
}
export function parseResult(result, choices) {
  if (result.status === 130) return { action: "cancel" };
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error("fzf failed");
  const [query, key, ...lines] = (result.stdout ?? "").replace(/\n$/, "").split("\n");
  // An expected key can exit with no-match status when the list is empty.
  if (key === "ctrl-r") return { action: "refresh", query };
  if (key === "left" || key === "right") return { action: "sort", query, direction: key === "left" ? -1 : 1 };
  if (result.status === 1) return { action: "cancel" };
  if (key !== "" || lines.length !== 1) throw new Error("Invalid picker selection");
  const choice = choices.get(lines[0].split("\t")[0]);
  if (!choice || choice.line !== lines[0]) throw new Error("Unknown picker selection");
  return { action: "select", binding: choice.binding };
}
export function fzfEnv(env = process.env) {
  // No inherited previews, execute/become bindings, default commands, history or
  // options files. The only fzf input is our pipe; there are no shell actions.
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("FZF_")));
}
export function runFzf(choices, query) {
  return spawnSync(FZF, ["--no-multi", "--no-sort", "--tiebreak=index", "--sync", "--layout=reverse",
    "--ansi", "--delimiter=\t", "--with-nth=2..", "--print-query", "--expect=ctrl-r,left,right",
    "--bind=esc:abort,ctrl-c:abort,ctrl-b:backward-char,ctrl-f:forward-char", "--query=" + query,
    "--prompt=Live agents> ",
    "--header=" + ((process.stderr.columns ?? 80) < 68
      ? "Enter go · ^R refresh · ←/→ sort · Esc cancel\nLast seen ≠ live; idle ≠ accepted."
      : "Enter validate/go · Ctrl-R refresh · ←/→ sort · Esc cancel\nLast observed; age ≠ freshness · idle ≠ accepted.") + "\nSort: " + choices.sort + "\n\n" + choices.heading], {
    input: [...choices.values()].map(c => c.inputLine + "\n").join(""),
    encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], env: fzfEnv(), maxBuffer: 1024 * 1024
  });
}
function validContext(c) {
  return c && typeof c.socket === "string" && isAbsolute(c.socket) && !c.socket.includes("\0") &&
    clientPattern.test(c.client) && validProcess(c.server) && validProcess(c.process) &&
    typeof c.created === "string" && /^[0-9]+$/.test(c.created);
}
export function decodeContext(token) {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(token)) throw new Error("Invalid picker context");
  const c = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  if (!validContext(c)) throw new Error("Invalid picker context");
  return c;
}
export function observeClient(socket, client, pid) {
  if (!isAbsolute(socket) || !clientPattern.test(client) || !/^[1-9][0-9]*$/.test(String(pid))) {
    throw new Error("Explicit socket, terminal client and client PID required");
  }
  const clients = tmux(socket, ["list-clients", "-F", "#{client_name}\t#{client_pid}\t#{client_created}\t#{pid}"])
    .split("\n").map(s => s.split("\t")).filter(r => r[0] === client && r[1] === String(pid));
  if (clients.length !== 1) throw new Error("Invoking client detached or replaced");
  const [,, created, serverPid] = clients[0];
  const ps = processesFor([Number(pid), Number(serverPid)]);
  const c = { socket, client, created, process: ps[pid], server: ps[serverPid] };
  if (!validContext(c)) throw new Error("Client/server process identity unavailable");
  return c;
}
export function revalidateClient(c) {
  const current = observeClient(c.socket, c.client, c.process.pid);
  if (c.created !== current.created || !sameProcess(c.process, current.process) || !sameProcess(c.server, current.server)) {
    throw new Error("Invoking client/server changed");
  }
}
export function openPopup(socket, client, pid) {
  const context = observeClient(socket, client, pid);
  const token = Buffer.from(JSON.stringify(context)).toString("base64url");
  const command = [process.execPath, cli, "pick", "--context", token].map(shellQuote).join(" ");
  // -c always names the calling client, never tmux's implicit current client.
  // display-popup waits until closure; the inspector's 1.5s command timeout
  // must not be used for this intentionally interactive lifetime.
  const result = spawnSync("tmux", ["-u", "-N", "-S", socket, "display-popup", "-E", "-c", client,
    "-w", "92%", "-h", "75%", "-T", "Live agents", command], { stdio: "ignore" });
  if (result.error || result.signal || result.status !== 0) throw new Error("Popup unavailable");
}
export function navigate(context, selected, ops = { validateTarget, revalidateClient, tmux }) {
  // Refresh ownership, generation AND exact conversation. Location is deliberately
  // not identity: switch-client -t %ID resolves a moved pane at execution time.
  ops.revalidateClient(context);
  const current = ops.validateTarget(context.socket, selected.pane, selected);
  if (!sameTarget(selected, current.binding) || !sameProcess(context.server, current.binding?.server)) {
    throw new Error("Selected agent exited, changed conversation or was replaced; reopen the picker");
  }
  // Single navigation command. No -Z: tmux unzooms a previously hidden target.
  // -E avoids applying update-environment while switching sessions.
  ops.tmux(context.socket, ["switch-client", "-E", "-c", context.client, "-t", selected.pane]);
}
export function pick(context, ops = { readDisplay, runFzf, navigate }) {
  let query = "", sort = 'Recent';
  // No liveness assertion here. Client/owner checks belong to Enter, not list
  // population or refresh. Sorting only reorders the current snapshot.
  let rows = ops.readDisplay(context.socket);
  while (true) {
    const choices = makeChoices(rows, { terminalWidth: process.stderr.columns ?? 80, sort });
    const result = parseResult(ops.runFzf(choices, query), choices);
    if (result.action === "cancel") return;
    if (result.action === "refresh" || result.action === "sort") {
      query = result.query;
      if (result.action === "refresh") rows = ops.readDisplay(context.socket);
      else sort = result.direction === -1 ? previousSort(sort) : nextSort(sort);
      continue;
    }
    ops.navigate(context, result.binding);
    return;
  }
}
