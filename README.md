# pi-tmux-continuity

Exact Pi/Claude tmux registration, read-only inspection and an opt-in live-agent
picker. Registration/navigation does **not** save workspaces or launch agents.
A separate [bounded Pi recovery adapter](src/recovery/README.md) provides explicit
paired saves and fresh-owned-server recovery. It is inactive by default, not a
production workspace lifecycle.

## Requirements and loading

- Node >=22.18, Python 3 and tmux (tested with 3.5a).
- Pi with session lifecycle, `ctx.mode`, `agent_settled` and UI prompt events
  (tested with Pi 1.1.0 / Node 24.10.0).
- Registration supports macOS libproc and Linux procfs; Linux is not integration
  certified here. Foreground process-group leadership, pane TTY and ancestry
  must be verifiable; uncertain wrappers/background processes are refused.
- Picker additionally requires `/opt/homebrew/bin/fzf` (tested with 0.65.1).
  Recovery uses machine-specific macOS tool/plugin paths; see its runbook.

No runtime npm dependencies: the host supplies Pi. From a disposable tmux pane:

```sh
pi -e /absolute/path/to/pi-tmux-continuity
# Or use the generated root extension.ts, not src/extension.ts.
```

This is opt-in for that invocation, not a global install. Nothing installs hooks,
keybindings, timers or daemons. Outside tmux, noninteractive/print/JSON/RPC modes
and redirected streams are inactive. Normal TUI operation is silent;
`/tmux-binding` shows registration/activity diagnostics without a model prompt.

Ship the whole package layout: the generated root `extension.ts` uses Python
assets under `src/`. After source changes, build before a user-approved `/reload`.
The root bundle supports transitive updates on the tested host; loading
`src/extension.ts` directly retains native-JS caching limitations. Existing owners
without materialized display metadata need a lifecycle event/reload to appear in
the picker; opening it does not backfill registrations.

## Inspect and navigate

```sh
node bin/inspect.js inspect --socket /absolute/tmux/socket --json
node bin/inspect.js display --socket /absolute/tmux/socket --pane '%5'
```

Without `--socket`, inspection uses the socket in `TMUX`; it never chooses another
server or starts one. Inspection revalidates process births, foreground ownership,
server/pane/TTY and exact conversation references. `display` emits fixed safe
tokens only. Neither command alters configuration or launches agents.

The picker entry point is intended for an explicitly reviewed tmux keybinding:

```text
node /absolute/path/to/bin/picker.js open --socket SOCKET --client CLIENT --client-pid PID
```

Supply the invoking tmux client's exact socket/name/PID, not inferred defaults.
It opens a popup for that client. Type to filter, Enter to validate/navigate,
Ctrl-R to refresh, Esc/Ctrl-C to cancel. Left/Right cycle Recent → Project/folder →
Session → Agent → Status; Ctrl-B/Ctrl-F move the query cursor. Sort/filter preserve
query text. Recent uses recorded activity time, not file timestamps or liveness.

Rows are **last-observed**, not a live inventory: crashed owners may remain until
another event. Enter strictly validates only the selected owner/conversation and
invoking client before one switch; stale/ambiguous selections refuse. It does not
restore, launch, poll processes or scan transcripts. Validation and navigation
are separate operations, so a final check-to-switch race remains. Normal PTY
clients are supported, not control mode; shared tmux sessions still share focus.

Custom names come only from Pi's public session-name API or supported Claude
`session_title` hook fields; absent names are `Unnamed`. No pane-title/transcript
inference. Display controls are escaped and inherited `FZF_*` configuration is
removed. Working is yellow, idle blue, attention amber, unknown grey. Idle never
means accepted work. Refresh explicitly: ages and activity are snapshots.

## Managed workspaces

A managed workspace is a tmux server whose layout and agents survive the server ending: a
crash, `kill-server` or reboot. Every server, the default one included, follows the same rules;
only presentation differs. Everything is plain tmux, with no extra CLI. Source `tmux/scope.conf`
once, last, from your tmux configuration.

- **Workspaces are servers.** `tmux` is the default workspace; `tmux -L acme` is workspace
  "acme". Each server is separate, so `choose-tree`, tmux-fzf and the agent picker show only
  that workspace. Named workspaces show their name in the status bar (amber block) and the
  window title; the default server shows nothing extra.
- **Opt in with `prefix C-s`.** The first explicit save adopts the server as a managed
  workspace, bound to that exact socket. Unmanaged servers are never saved or restored, so a
  socket alone is never permission to manage a server.
- **Saving:** `prefix C-s` any time; managed workspaces also save when a client detaches and
  every five minutes while attached.
- **Restoring:** when a managed workspace's server starts (`tmux`, `tmux -L acme`), its last
  recovery point is rebuilt: sessions, windows, splits, directories, then each saved Pi and
  Claude is resumed in its pane and checked to have re-registered with its exact conversation.
  A status-line message reports how many agents resumed. It runs once per server start, never
  on a config reload. `PI_TMUX_SCOPE_FRESH=1 tmux -L acme` starts empty instead.

```sh
tmux -L acme                 # start or come back to workspace "acme"
tmux -L acme attach          # attach to it while it runs
tmux -L acme kill-server     # end it; the next start restores it
```

### Guarantees and limits

- **Existing work is never disposable.** Restore replaces only the session tmux created when
  the server started (auto-numbered, created with the server, one shell pane, nothing started
  in it). Named sessions and sessions in use are kept; a saved session whose name is taken is
  reported, not merged.
- **No guessing, no doubles.** An agent is launched only when its saved process is proven gone
  (only "no such process" counts; unobservable means not launched), its directory exists, and
  its conversation reference checks out: Pi by exact file and header, Claude by exact session
  ID with its transcript present. Each conversation is launched at most once. pi-subagent
  conversations stay with pi-subagent, and subagent-only sessions are not recreated.
- **The last good recovery point survives a partial restore.** If any agent was not resumed or
  not verified, the workspace is marked degraded (`!` in the badge): automatic saves pause until
  you accept the current state with `prefix C-s`. Older recovery points are kept (last 50).
- **One operation at a time.** Saves and restores take a per-workspace lock; topology that
  changes during a save refuses the save rather than recording a mix.
- **Reported, not assumed.** `last-restore.json` lists what was launched, what verified, and
  every gap; errors go to `errors.log`. Both are in `~/.local/state/tmux/scopes/<name>/`.

Saves record sessions, window names and layouts, pane directories and exact agent references.
They never record commands, pane contents, transcripts or environments. Agents come back with
your normal setup, without launch flags such as permission modes, and no prompt is sent. This
is reconstruction, not process checkpointing: shell state, scrollback and interrupted tool
calls are not restored. Named workspaces do not load Resurrect/Continuum. On the default
server, `prefix C-s` belongs to managed workspaces once this config is loaded.

`node test/manual/verify-scopes.js [--keep]` exercises the same contract on a named workspace and
on a sandbox `default` server, with real offline Pi, under both a fixture config and the user's
tmux config. A guard `tmux` refuses any socket outside the sandbox, and the run checks the real
default server's PID is unchanged.

## Ownership, privacy and activity

Namespaced pane options contain exact file/ID/cwd, process births, activation and
observed activity—not prompts, transcript bodies, environment dumps or credentials.
Pi file checks read only the bounded first JSONL header. A matching header marks
persistence, not transcript integrity or permission to recover. Metadata is
sensitive and trusted same-user state, not an adversarial security boundary.

Each activation retains its own diagnostic option; newer closed/ambiguous
activations block fallback to old conversations. Display publication uses scoped
compare-and-swap, not arrival-order overwrite. Pane movement follows stable live
pane IDs; these are not durable recovery coordinates. Inspection is point-in-time,
not a lock. Foreground jobs can temporarily make an owner unverifiable.

Pi idle requires native settlement, idle state and no queued messages; blocking
extension UI indicates attention. Claude activity requires correlated native
signals: Stop is not settlement, PermissionRequest is not necessarily a human
prompt, and missing correlation stays unknown. Dropped hooks cannot be rebuilt.
No timeout guesses that long work is idle. Diagnostic options and Claude events
remain until pane/server destruction; no GC exists, so strict inspection and
Claude writer cost grow with retained history. Fast picker listing reads one
materialized display slot per pane, independent of that history.

## Claude hooks (proposal only)

```sh
node bin/claude-config.js --claude-bin /absolute/path/to/native/claude
# Optionally merge a reviewed settings COPY, without writing configuration:
node bin/claude-config.js --claude-bin /absolute/path/to/native/claude \
  --merge-stdin < reviewed-copy.json
```

This only prints proposed JSON; review before any separately authorized activation.
Native exec-form hooks are required (contract checked against Claude 2.1.301);
Node/npm launchers, headless/SDK/background/subagent owners are unsupported.
Do not configure async hooks. Regenerate proposals after Node/package path changes.
The hook adapter is silent and fail-open: it never supplies a decision or prompt.
Fork events are conservatively closed rather than attributed ambiguously.

References come from native hook file/ID fields. Claude file checks do not read
transcript bodies and always leave recovery identity/integrity unverified.
Turn/tool/permission/idle coverage is synthetic; native lifecycle coverage is
limited. The lab adapter in `src/recovery/` does not recover Claude; scope restore resumes
Claude by exact session ID (see Managed workspaces). No native Claude/auth experiment is
part of the offline suite.

## Development and verification

The checked-in root bundle is essential; modular `src/` is authoritative.
Dev-only esbuild is pinned in the lockfile. For a new development checkout,
`npm ci --legacy-peer-deps` supplies the bundler without installing another Pi.
Normal runtime loading needs no build dependency.

```sh
npm run build              # regenerate extension.ts after source/build changes
npm run check:bundle       # deterministic freshness check, no rewrite
npm test                   # current unit tests (explicit maintained allowlist)
npm run test:integration   # serialized, isolated offline Pi/tmux integrations
node test/manual/verify-durable-recovery.js
npm pack --dry-run
```

Tests/pack check bundle freshness rather than silently rebuilding. Integration
requires existing Pi, tmux, Python and picker fzf; it uses private HOME/agent
directories, invented histories, offline Pi without prompts, and uniquely owned
sockets. Claude integration uses a synthetic owner, not the native executable.
The durable runner supplies an allowlisted environment, runs probe/unit/admission
tests and a real-Pi new-process persistent-store round trip, and cleans owned
servers/agents. Read the [recovery runbook](src/recovery/README.md) first. It writes
ignored verification output under `evidence/`; no checked-in report is required.

`node test/benchmark-picker.js LABEL` is an optional owned-fixture PTY benchmark.
Historical spikes and their wrappers are excluded from the maintained test graph.
Tests/fixtures are in Git but not shipped in the npm runtime package.

## Recovery limits

Recovery only owns explicitly created private stores/servers. Managed live or
uncertain owners and unresolved generations block new-label recovery (DR-1).
Existing/consumed addresses are attach-only; locks are never stolen and uncertain
launches are not retried. No production server adoption, fixed-address lifecycle,
attached-client capture, automatic saving or degraded-state resolution is supplied.
At most one coordinator-issued launch attempt per conversation/owned generation
is not machine-wide exclusivity. Header checks do not eliminate the file-open
race. Filesystem synchronization is not reboot/power-loss certification. There is
no installer, boot/login automation, Ghostty requirement or production activation.
