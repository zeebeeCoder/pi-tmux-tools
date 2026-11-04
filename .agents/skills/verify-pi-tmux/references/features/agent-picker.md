# Live agent picker

A keyboard popup lists every registered agent on the current tmux server, with tmux session, window index/name and pane index first, then optional conversation name and folder, agent kind, coloured activity dot and the age of its last event. You type to filter, change the sort with Left/Right, and press Enter to jump to that agent's pane. Rows are last-observed, not a live inventory. Only Enter strictly re-validates the chosen owner and conversation before switching.

## Sub-features

- `pick-list`: one row per registered agent on this server only. Tmux location identifies named and unnamed conversations alike; missing conversation names show `—`. Narrow popups omit folder, then conversation, preserving location.
- `pick-filter`: typing filters the list. Ctrl-B/Ctrl-F move the query cursor.
- `pick-sort`: Left/Right cycle Recent → Project/folder → Conversation → Agent → Status. The query is kept. Recent is the default for each new popup.
- `pick-refresh`: Ctrl-R reloads the rows and keeps the sort mode and query.
- `pick-navigate`: Enter validates the selected owner and conversation, then switches the invoking client to that pane.
- `pick-refuse`: a stale or replaced owner is refused, and nothing moves.
- `pick-cancel`: Esc or Ctrl-C closes the popup with no change.

## How to get to it (user POV)

- `prefix a`, if the user has bound it. The binding is a reviewed line in the user's own `tmux.conf` that runs `bin/picker.js open --socket … --client … --client-pid …`. The package does not install it.

## Driving it with the sandbox harness

Preconditions:

- Launch and Doctor from the skill pass. fzf is at `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`.
- `user-r` holds at least two registered Pis.

- **Automated PTY path.** Run `node --test --test-concurrency=1 test/integration/picker.test.js test/integration/picker-sort.test.js`. Every test passes. These tests drive real fzf inside owned PTY clients and cover list, sort, query editing, refresh and exact navigation.
- **Human path: bind.** Attach a real terminal with the full `attach:` line that `--keep` printed. Then run `tmux -S "$S" bind a run-shell -b "node $REPO/bin/picker.js open --socket #{q:socket_path} --client #{q:client_name} --client-pid #{client_pid}"`.
- **Open and filter.** Press `prefix a`. A popup lists only `user-r`'s Pis, newest first. Check session/window names against the tmux status bar, including unnamed agents and multiple panes in one window. Type part of a visible tmux session or window name and the rows narrow. Rename a sandbox window, press Ctrl-R, and check the new label; Enter still targets the exact pane.
- **Sort.** Press Right. The header shows `Project`, and the query text is unchanged.
- **Navigate.** Select a Pi in another window and press Enter. The client's active pane becomes that Pi's pane. Confirm with `tmux -S "$S" display -p '#{pane_id}'`.
- **Refuse stale.** Note one Pi's pane, then kill that Pi with `tmux -S "$S" send-keys -t <pane> C-d`. Open the picker, select the stale row and press Enter. The picker refuses, and the active pane does not change.
- **Proof.** Screenshot the popup with the `user-r` badge visible. Also save the `display -p '#{pane_id}'` output before and after Enter.

## Gotchas

- The popup is not a recovery browser. It never restores or launches anything, and it never polls processes when it opens.
- A crashed agent can still be listed until another event happens. That is by design. The proof is the refusal on Enter, not the row disappearing.
- Ages are snapshots. Reopen the popup or press Ctrl-R before asserting a relative time.
- Control-mode clients are unsupported. Clients that share a tmux session also share focus, so the switch moves every client in that session.
- There is a small race between validation and switching. A refusal proves the stale guard, but one successful switch does not prove the race is closed.
- In tmux 3.7, `list-keys -T prefix a` prints nothing even when the key is bound. Prove the binding by pressing the key, not by listing keys.
