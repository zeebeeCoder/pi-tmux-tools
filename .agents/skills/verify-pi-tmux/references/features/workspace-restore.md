# Managed workspace: restore

When a managed workspace's server starts again after a crash, `kill-server` or reboot, its last recovery point is rebuilt: sessions, windows, splits and directories come back, then each saved Pi and Claude is resumed in its own pane with its exact conversation (`pi --session <file>`, `claude --resume <id>`). Each one is checked to have re-registered. The status line reports how many agents resumed. Any agent that cannot be resumed exactly becomes an explained gap, never a guess. This runs once per server start, never on a config reload.

## Sub-features

- `restore-topology`: same sessions, window names, layouts and pane directories.
- `restore-agents`: each saved Pi or Claude runs again in the same pane as a new process with the same conversation, then is verified.
- `restore-gap`: a missing file, header mismatch, missing cwd or unsupported path character becomes a gap listed in `last-restore.json`, and the rest of the workspace still restores.
- `restore-degraded`: any gap or unverified agent puts `!` in the badge and pauses autosave, so the last good recovery point survives.
- `restore-keep-work`: only the untouched start-up session is replaced. Named or in-use sessions are kept, and a saved session whose name is already taken is reported.
- `restore-once`: a config reload never restores again.
- `restore-fresh`: `PI_TMUX_SCOPE_FRESH=1` starts the workspace empty.
- `restore-no-double`: an agent is launched only if its saved process is proven gone. Each conversation is launched at most once. Subagent conversations are left to pi-subagent.

## How to get to it (user POV)

- `tmux -L acme attach || tmux -L acme`: attach if the server is running, otherwise start it, which restores it.
- `tmux -L acme new -A -s api`: lands in the restored `api` session.
- After a reboot, start `tmux` for the default workspace.
- Read `~/.local/state/tmux/scopes/<name>/last-restore.json` and `errors.log`.

## Driving it with the sandbox harness

Preconditions:

- Launch and Doctor from the skill pass.
- **Right after Launch**, the kept server runs no agents, so do not save: a save would replace the recovery point that holds the Pi. The baseline is that point. Copy `$W/snapshots/$(node -p "require('$W/latest.json').file")` to `before-point.json`, and compare against its `sessions[].windows[].panes[].agent.file`.
- **On any later run**, once agents are live, run `node bin/tmux-scope.js save "$S"`, then capture `node bin/inspect.js inspect --socket "$S" --json > before.json`.

- **Crash.** Run `tmux -S "$S" kill-server`. `tmux -S "$S" ls` fails. If you captured `before.json`, `kill -0` fails for every Pi PID in it (`.panes[].binding.process.pid`).
- **Start = restore.** Run `tmux -u -f "$CONF" -S "$S" new-session -d`, then poll `tmux -S "$S" display -p '#{@scope-restoring}'` until it prints nothing (allow up to 30 s). `W="$PI_TMUX_SCOPES_HOME/user-r"`, and `$W/last-restore.json` has `action` `restored`, `degraded` `false` and every `launched[].verified` `true`.
- **Same conversations, same places.** Run `node bin/inspect.js inspect --socket "$S" --json > after.json`. For each saved Pi, `after.json` has the same `binding.sessionFile` at the same session, window and pane index, with status `live-persistent`. The saved Pis are the panes with an `agent.file` in `before-point.json`, or the `live-persistent` panes in `before.json`. When comparing against `before.json`, `binding.process.pid` must also be different.
- **Reload does not restore.** Run `tmux -S "$S" source-file "$CONF"`. `last-restore.json`'s `restoredAt` is unchanged.
- **Gap and degrade.** Save, then rename one saved Pi's history (`mv "$H" "$H.off"`), then repeat Crash and Start. `last-restore.json` lists that pane under `gaps`, every other agent is verified, and `#{@scope-degraded}` is non-empty. Run `node bin/tmux-scope.js save "$S"`, and `@scope-degraded` clears. Restore the history with `mv "$H.off" "$H"`.
- **Fresh start.** Run `tmux -S "$S" kill-server`, then `env PI_TMUX_SCOPE_FRESH=1 tmux -f "$CONF" -S "$S" new-session -d`. Exactly one shell session exists and `latest.json` is unchanged.
- **Proof.** Store `before-point.json` or `before.json`, `after.json`, every `last-restore.json`, and the output of `tmux -S "$S" list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'` before and after.

## Gotchas

- Use the smoke run for the full matrix. `node test/manual/verify-scopes.js` covers start-up session rules, in-use sessions, subagent skipping, the five-minute throttle and the save-during-restore refusal, under both the fixture config and your config.
- Restore only fires on a server younger than about 30 s. Starting the server and then sourcing `scope.conf` by hand much later will not restore.
- A Pi whose path contains spaces, `~` or a symlink (iCloud, Google Drive) is saved but not resumed. That gap is known and documented, not a regression.
- Windows come back numbered consecutively from `base-index`, not at their saved indices (F7). Compare by session, window name and order, not by raw index.
- Launch flags such as `--dangerously-skip-permissions` or permission modes are not restored, and no prompt is sent. A resumed agent waiting for input is the correct outcome.
- Real-target variant, run by a human only: `node test/manual/drill.js before`, then end and restart your real server, then `node test/manual/drill.js after`. The drill is read-only, but ending the server is not. Never script `kill-server` against `/tmp/tmux-$(id -u)/default`: if the sandbox's tmux directory is missing, tmux falls back to the real one and that command kills the user's server.
- Native Claude resume and reboot have been checked only by manual drills. The sandbox covers Claude planning only. Report native Claude as `verified-unreachable` unless it was separately approved.
