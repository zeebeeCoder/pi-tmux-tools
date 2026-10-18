# Explicit paired-store / owned-server adapter (bounded, inactive)

**Not production-ready or overall recovery acceptance.** This standalone adapter
uses a version-2 paired-store format, persistent authority and fail-closed
managed-owner admission (DR-1). It does not activate production recovery or
change the live registry/picker.

## One fresh-shell verification command

```sh
node test/manual/verify-durable-recovery.js
```

No installation, credentials, inherited API keys, task prompts, Claude execution,
production servers or terminal application are needed. The wrapper supplies a
small allowlisted environment to every child, checks bundle freshness, runs all
unit tests, recovery-local probe tests, five real shell-only authority/admission
regressions and the delivered-adapter real-Pi round trip. The round trip now
attempts different-label recovery while the source Pi and later recovered Pi
are still live: the adapter itself must refuse before any pin/socket/entry is
created, with original PIDs and pointer unchanged. Only afterward does the test
stop its owned server and demonstrate successful fresh-label recovery. It writes a timestamped `output.txt` under
`evidence/durable-recovery-delegation/`. The round trip writes its own sanitized
`report.json`, including hashes, exact-reference samples, pane maps and cleanup.

The runner creates an ignored private `.recovery-test-state/<uuid>/` on this
repository's filesystem. Its **persistent store and invented histories are
separate from `/private/tmp/durable-recovery-<uuid>`**, which holds sockets only.
A saving child creates two independent sessions, native A/B and ordinary Bash
panes, saves via the delivered CLI, switches A to C using the unchanged lifecycle
fixture, and saves again with identical layout. That child exits. The parent
stops only its owned source server, verifies tracked source agent births exited,
and deletes the entire runtime directory. A new CLI process then recovers using
only the explicit persistent store and surviving files/repository dependencies.
The test does not reuse a Lab object or temporary ownership record.

Default cleanup is mandatory; no `--keep` mode is offered. Inspect the sanitized
report after completion, not a retained running agent. If cleanup fails, the
runner prints the exact retained store and ownership-verified cleanup command.
Do not delete a lock or ownership history to get recovery to run.

## CLI

```text
node bin/recovery.js init /absolute/config.json
node bin/recovery.js save /absolute/store source
node bin/recovery.js inspect /absolute/store
node bin/recovery.js recover /absolute/store unusedlabel
node bin/recovery.js cleanup /absolute/store
```

- `init`: creates a **new** private persistent store and separate unused runtime
  directory. Both parents must already exist; neither path may exist. No server
  is started. Configuration is persisted in `ownership.json`.
- `save`: explicitly captures a coordinator-owned source or fully **complete**
  recovered server. Creating/restoring/launching/uncertain/gapped generations
  cannot publish. A later explicit complete-generation save retains its original
  pinned source pair and immutable source pointer. It does not
  adopt or alter an existing production/foreign server. JSON output acknowledges
  successful pair synchronization/readback or reports failure.
- `inspect`: read-only validation of the latest pair and authoritative ownership
  history, with an explicit Claude-unverified notice. No tmux commands, launch,
  lock creation or native transcript-body reads. References/provenance are
  sensitive metadata; keep the store private.
- `recover`: only a new, unused label can create an owned server and recover.
  Existing live servers, consumed addresses (even with dead socket files removed)
  and partial generations are **attach-only**, without launching or attaching a
  terminal client. Before any fresh-label pin or server creation, the adapter
  reloads authority under its existing lock and proves every recorded managed
  server, tracked agent, and selected/recorded-pinned manifest process identity
  gone. Live or uncertain identities, stale/unanchored source provenance and
  unresolved generation phases refuse. An external existing server is also attach-only. A crash lock
  blocks new work; it is never stolen. Results: `complete`,
  `complete-with-gaps`, `uncertain`, or `attach-only`. Exit 1 means refusal; exit 2
  means an uncertain recovery. Attach-only includes a consumed *dead* address,
  not a promise that an attachable server exists.
- `cleanup`: holds the same lock, reloads authority, stops only identity-verified
  owned servers and verifies tracked agents exited. It does **not** delete stores,
  pairs, histories, runtime directories or consumed-address records. It refuses
  uncertain/replaced ownership or a leftover lock. Human investigation is needed
  in those cases; no force-unlock/replay command is supplied. Cleanup does not
  resolve uncertain phases: even after all resources exit, those phases block
  every fresh recovery label until a separately approved resolution exists.

Example **inactive** config (replace with newly allocated private test paths):

```json
{
  "store": "/absolute/persistent-parent/new-store",
  "runtime": "/private/tmp/new-unique-socket-directory",
  "settings": { "width": 100, "height": 32, "base": 1, "paneBase": 1, "renumber": "on" }
}
```

One store owns one immutable runtime namespace. Do not share/reassign that
namespace between stores or erase its history. A later recovery needs a new
unused label, not deletion of a consumed record. Fixed-address main-server reuse,
source adoption and human resolution after degraded recovery are **not implemented**. Those are
explicit integration gaps, not automatic authority. Consequently this is not yet
a drop-in production workspace lifecycle.

### Module/API

`src/recovery/model.js`: complete layout/metadata validation, header-only exact
reference check, preflight, synchronized publication/readback and exclusive lock
capabilities. `Coordinator` in `coordinator.js` exposes `create(config)`,
`new Coordinator(store)`, `save(socket)`, `connect(label, pointer?, options?)`,
`cleanup()`. `connect` can pin an explicit previously committed pointer; it never
selects an older pair to compensate for missing conversations.

`start(label, 'source')`, `tmux`, `piCommand`, `registration`, `stop`, `agentsGone`
and the synchronous fault callbacks are low-level **owned fixture/API building
blocks**, used by the verification runner. They are not an adoption interface or
permission to manipulate production sockets. Source construction stays explicit;
there is intentionally no CLI accepting arbitrary shell commands. A future
approved caller/scheduler must route paired saving and recovery through this
same coordinator, not invoke upstream save/restore directly. No hooks, timers,
keybindings, Continuum or Ghostty integration are activated here.

## Persistence and authority

The configured store retains `pairs/<uuid>/{layout.txt,manifest.json}` and atomic
`pairs/latest.json`, plus its immutable namespace identity and append-preserved
server-generation history in `ownership.json`. Every destination records its exact
source pointer before bootstrap. Recovery also writes/readbacks a private pinned
copy of the complete pair and never follows mutable upstream `last` afterward.
All complete pairs are retained; **no automatic retention/GC** is implemented.
Capture directories, profiles and operation audit are also retained until explicit
fixture cleanup. This can grow; do not install as an unattended saver.

The entire pair is structurally validated and checksummed before pointer
replacement. Pair files, pointer, ownership and lock writes, and relevant
directories are synchronized; the committed pointer/pair is read back. A
prepublication failure preserves the previous pointer; a post-pointer failure is
reported as **published; durability uncertain**, not rollback. This acknowledges
successful filesystem calls, **not sudden-power-loss durability**, filesystem
fault recovery, or independently owned Pi transcript flushing.

One exclusive store lock serializes save/recovery/cleanup. Per-acquisition opaque
capabilities, authoritative reloads, stale-byte comparison, immutable generation
history and process-birth tracking reject stale writers.
There is no daemon, database, timeout-based lock stealing or per-agent attempt
ledger. Agent PID/birth history now supplies conservative admission blockers as
well as cleanup evidence; it never authorizes an individual launch.

DR-1 admission reads only explicitly recorded PIDs and socket paths. Its separate
macOS `admission-probe.py` returns an explicit result for every request: only
`ESRCH` means process absence; successful PID/birth observation distinguishes
reuse or a non-running zombie from the original live identity. Permissions,
short reads, malformed/omitted results, timeouts and other errors are unknown,
not absent. Each recorded socket must also be absent or definitively refusing
connections; a live/replaced socket or uncertain path refuses. The socket check
connects without sending any tmux command/protocol payload. The stable registrar
`src/process-info.py` contract is unchanged and is not used to prove admission.

Only source/source and destination/complete or complete-with-gaps are resolved
phase combinations, and they still require all known identities gone. Every
other phase, including creating/restoring/launching/uncertain or missing identity,
blocks a fresh label. A completed missing-reference gap is a known shell outcome,
not an uncertain launch. Source provenance must match immutable store/server
history. Selected and previously recorded recovery-source pairs contribute saved
process identities even if they were never added to agent cleanup history.

This is intentionally one-store conservative: an unrelated live managed workload
also blocks fresh recovery. No process-table/ancestry scan, killing, launch retry,
lock stealing, external-owner discovery or automatic uncertainty resolution is
performed. Existing-target attach-only bypasses admission and remains read-only,
including with unresolved history or a leftover coordinator lock.

Every mutation after exclusive bootstrap, including every native plugin tmux
child, goes through `tmux_guard.py`: explicit socket, socket inode, process birth,
generation marker and a second generation condition evaluated inside tmux.
The guard is a scope interposer for reviewed code, **not a hostile-code sandbox**.
Store/config/repository/installed tools and the same-user filesystem are trusted;
checksums and mode bits are not adversarial tamper protection.

## Capture / restore boundary

- Strict registrar inspection, not picker/display rows, supplies exact Pi
  file/ID/cwd and owner/process provenance. Topology, pane PID/birth/TTY and strict
  bindings bracket upstream capture. Drift/ambiguity refuses publication. This is
  a validated quiescent observation, not a transaction freezing agent lifecycles.
- Installed Resurrect scripts are unmodified and checked against
  `resurrect-contract.json` before execution. Unknown source hashes refuse.
  Review is needed after plugin upgrades; do not just update the hashes.
- `save.sh` always collects commands unless its strategy is replaced.
  `@resurrect-processes=false` alone only disables replay. A private no-output
  strategy is selected through the installed strategy-path semantics, verified
  once per pane. The guard substitutes constant title/command-name fields BEFORE
  tmux emits upstream save data. No argument/title/body capture then redaction.
  Bare `ps`/`pgrep` are denied in the private PATH. Source capture hooks and pane
  contents are refused. Each save gets isolated staging, avoiding same-second
  filenames and unchanged-candidate deletion hazards. Conversation-only changes
  always publish new matching metadata.
- Recovery awaits actual Resurrect, uses only pinned layout input, clean Bash,
  never-overwrite, no contents or program replay. No post-restore hook is success
  evidence. It verifies membership, indices, names, cwd, recursive geometry and
  fresh pane mapping before native launches. Runtime numeric pane IDs are not
  durable coordinates.
- Ordinary supported Bash panes become clean shells, not saved programs.
  Native Pi uses `--session /absolute/exact/file.jsonl`, never `--resume <id>`, no
  positional message, no lookup/fallback. The adapter reads at most the first
  16 KiB metadata line, stopping at its newline; it does **not** parse transcript
  bodies. Regular/nonempty file and matching version-3 header/ID/cwd are checked
  immediately before launch; resulting native registrations are checked afterward.
  Header-only files and invalid/missing references leave explained gaps. Missing
  cwd or malformed pairs refuse before server creation. Different pane and header
  cwds are explicitly unsupported. Body integrity is owned by native Pi, not
  independently certified here. The check-to-Pi-open deletion/replacement race
  remains; no strict-open/core patch is claimed.
- Each native launch gets a **new empty private agent configuration directory**,
  private HOME and explicit private `--session-dir` (no project session-directory
  fallback), allowlisted environment, offline mode, telemetry/version checks,
  cache warming, compaction and retries off; no discovered resources/extensions,
  MCP/context, tools, saved commands or prompts. Only the unchanged registrar
  loads during recovery. Pi may create an empty native auth file there; the
  coordinator never reads or reuses it. Profiles are configuration artifacts,
  not per-agent attempt records. No proof is extended to arbitrary user startup
  extensions/settings, and offline mode is not a network sandbox.

**Launch guarantee:** at most one coordinator-issued launch attempt per distinct
conversation per owned generation. Duplicate file/ID plans are rejected. No
retry after timeout/uncertainty, automatic restart, partial restore replay,
machine-wide exclusivity or discovery of unknown external survivors. Known
managed survivors are now admission blockers even when their sockets are absent;
this does not certify that unrecorded processes cannot exist.

## Supported / refused

Tested on this installed macOS toolchain: Node 24.10.0, tmux 3.5a, Pi 1.1.0,
`/usr/bin/python3`, `/opt/homebrew/bin/{tmux,pi}` and the machine-local plugin path
in `coordinator.js`. No installer or portability claim.

Supported format: independent simple ASCII-named sessions/windows, canonical
absolute ASCII paths outside the store allowed, one configured common window
size (40–400 by 10–200), consistent base/pane-base 0 or 1, no zoom, automatic
rename off, at most 32 panes/16 windows and source pane IDs ≤1024. Executed real
cases: **100×32 / base1 / renumber on / two independent sessions / horizontal
and vertical splits**, and **140×45 / base0 / renumber off**. Wider parameter
bounds are parser limits, not an exhaustive geometry certification. Sparse window
indices require renumber off. Pane indices must be contiguous from the configured
base. Linked/grouped topology, mixed bases/sizes, clients attached during capture
or verification, spaces/escapes/tabs/newlines/symlink paths, unusual names,
non-Bash unregistered occupants and ambiguous/nonpersistent agents refuse.
Client focus/alternate-window selection, pane titles, scrollback and environment
are not restored. The source title placeholder remains `lab-pane` for the derived
wire-format contract; no original title is captured.

**Claude is unsupported/unverified**, visibly refused rather than guessed or
silently treated as a proven native resume. No Claude/auth test was run.
No hardware reboot/power-loss certification, production activation,
terminal-opening trigger, boot/login automation or live configuration change
is provided.
