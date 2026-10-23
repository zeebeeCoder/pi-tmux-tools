# Managed workspace: adopt and save

A tmux server becomes a managed workspace the first time you press `prefix C-s` on it. From then on its layout and exact agent conversations are saved as recovery points: on `prefix C-s`, when a client detaches, and every five minutes while a client is attached. Named servers show their name in the status bar and the window title; the default server shows nothing extra. A server you have never saved is never saved or restored.

## Sub-features

- `save-adopt`: the first explicit save writes `workspace.json`, bound to that exact socket.
- `save-explicit`: `prefix C-s` writes a new recovery point and shows `workspace <name> saved: N sessions, N Pi, N Claude`.
- `save-detach`: detaching a client saves a managed workspace.
- `save-autosave`: redrawing the status line saves at most once every 300 s.
- `save-unmanaged`: detach and autosave do nothing on a server that was never adopted.
- `save-retain`: the last 50 recovery points are kept.
- `save-degraded`: after a partial restore, automatic saves pause and the badge shows `!`. The next `prefix C-s` accepts the current state and clears the `!`.
- `save-badge`: a named server shows an amber name block and a `[name]` title prefix. The default server shows neither.
- `save-no-secrets`: a recovery point holds sessions, windows, layouts, directories and agent references only. It holds no commands, pane contents, transcripts or environment.

## How to get to it (user POV)

- Source `tmux/scope.conf` last, once, from your tmux config.
- Press `prefix C-s` in any server: `tmux` (default) or `tmux -L acme`.
- Detach normally, or just stay attached and let autosave run.
- Look at `~/.local/state/tmux/scopes/<name>/`.

## Driving it with the sandbox harness

Preconditions:

- Launch and Doctor from the skill pass, including the restore step, so a Pi is live.

- **Explicit save.** Run `cat "$W/latest.json"`, then `node bin/tmux-scope.js save "$S"`, which is exactly what `prefix C-s` runs. The command exits 0, and `latest.json` now names a newer file under `$W/snapshots/`.
- **Snapshot content.** Read that snapshot. It lists every session from `tmux -S "$S" ls`, and each Pi pane has `agent.kind` `pi` with the exact `file`. It contains no `pane_start_command`, no environment, and no transcript text. Check with `grep -c '"role"'`, which should print 0.
- **Autosave throttle.** Run `node bin/tmux-scope.js autosave "$S"` immediately after the save. `latest.json` is unchanged.
- **Detach save.** Change the layout with `tmux -S "$S" new-window -d`, then run `node bin/tmux-scope.js detach "$S"`. `latest.json` advances, and the new snapshot has one more window.
- **Unmanaged is ignored.** Run `U="$TMUX_TMPDIR/tmux-$(id -u)/probe"`, `tmux -f "$CONF" -S "$U" new -d`, then `node bin/tmux-scope.js autosave "$U"`. `$PI_TMUX_SCOPES_HOME/probe` does not exist. Clean up with `tmux -S "$U" kill-server`.
- **Badge.** `tmux -S "$S" display -p '#{@scope-name}'` prints `user-r`, and `tmux -S "$S" show -gv status-left` contains `@scope-name`. For visual proof, attach and screenshot the amber `user-r` block.
- **Proof.** Store the `latest.json` contents before and after each step and the newest snapshot. For the probe step, store the output of `ls "$PI_TMUX_SCOPES_HOME"`.

## Gotchas

- Do not judge a save by the status message. With no client attached, there is no message at all. Judge it by `latest.json`.
- Autosave runs from the status line, so it only happens while a client is attached. Saving on detach covers the moment you leave.
- A save is refused while a restore runs (`@scope-restoring`), and also when the topology changes mid-capture. In both cases the save is refused, not partly written. Retry rather than reporting a regression.
- In a degraded workspace, autosave and detach are silently skipped until `prefix C-s`. Check `#{@scope-degraded}` before calling a missed autosave a bug.
- `prefix C-s` replaces tmux-resurrect's binding on every server, because `scope.conf` loads last.
- The workspaces under `~/.local/state/tmux/scopes/` are the user's real ones. Never point `save`, `restore` or `kill-server` at them during verification.
