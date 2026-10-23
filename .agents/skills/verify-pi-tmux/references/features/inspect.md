# Read-only inspection

The inspector tells a user, for one tmux server, which pane holds which exact Pi or Claude conversation, whether that binding is still valid, and whether it could be resumed. It never changes tmux, never launches an agent, and never looks at any server other than the one named or the one in `$TMUX`.

## Sub-features

- `inspect-json`: `inspect --json` lists every pane, with `status`, `restorable`, `persistenceReason`, `binding` and `activity`.
- `inspect-text`: `inspect` without `--json` prints a human-readable summary.
- `inspect-display`: `display --pane %N` prints one fixed-alphabet token: `agent:activity[:non-restorable]`.
- `inspect-scope`: without `--socket`, it uses only `$TMUX`. It never picks or starts another server.

## How to get to it (user POV)

- From inside tmux: `node bin/inspect.js inspect`, or `node bin/inspect.js inspect --json`.
- For a specific server: `node bin/inspect.js inspect --socket /absolute/socket --json`.
- For one pane: `node bin/inspect.js display --socket /absolute/socket --pane '%5'`.

## Driving it with the sandbox harness

Preconditions:

- Launch and Doctor from the skill pass, including the restore step, so `user-r` holds a restored offline Pi.

- **List panes.** Run `node bin/inspect.js inspect --socket "$S" --json > insp.json`. It exits 0. `.socket` equals `$S`, and every `.panes[].status` is one of `live-persistent`, `live-non-restorable`, `unregistered`, `pane-changed-during-inspection` or `inspection-failed`.
- **Shells are honest.** Ordinary shell panes show `unregistered` with no `binding`.
- **Display token.** Pick a Pi pane: `P=$(node -e 'const j=require("./insp.json");console.log(j.panes.find(p=>p.binding?.agent==="pi").pane.pane)')`. Then run `node bin/inspect.js display --socket "$S" --pane "$P"`. Stdout is exactly `pi:idle`, `pi:working`, `pi:needs-attention` or `pi:unknown`, optionally followed by `:non-restorable`. A just-restored Pi reads `pi:unknown` until its first settled turn. A shell pane reads `none:unknown`.
- **No mutation.** Capture `tmux -S "$S" list-panes -a -F '#{pane_id} #{pane_pid}'` before and after both commands. The two outputs are identical.
- **Scope refusal.** Run `env -u TMUX node bin/inspect.js inspect`. It exits non-zero instead of choosing a server.
- **Proof.** Store `insp.json`, the display stdout and both `list-panes` captures.

## Gotchas

- Inspection is point-in-time, not a lock. A pane can change between reads, and that shows up as `pane-changed-during-inspection`. Re-run instead of treating it as a failure.
- A foreground job inside a Pi pane (for example `!vim`) can make the owner temporarily unverifiable.
- Strict inspection gets slower as diagnostic history accumulates in pane options. Nothing garbage-collects that history, so a long-lived real server is slower than the sandbox.
- It is safe to run against your real server, because it is read-only. Only the sandbox steps are needed for proof.
