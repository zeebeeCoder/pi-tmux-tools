# Exact agent registration

An interactive Pi (loaded with this extension) or a hooked Claude in a tmux pane records its exact conversation reference against that pane. It never guesses from the directory or from recency. Two agents in the same directory stay distinct, and a background child cannot claim its parent's pane. Normal use is silent. `/tmux-binding` shows the current Pi's binding without a model request.

## Sub-features

- `reg-pi`: a foreground Pi registers its pane, cwd, conversation file and ID on startup, new, resume, fork and `/reload`.
- `reg-distinct`: two Pis in one cwd hold two different bindings.
- `reg-persistence`: a conversation file that exists with a matching header is `live-persistent`; an unsaved one is `live-non-restorable`.
- `reg-selfcheck`: `/tmux-binding` prints this instance's binding JSON, or a "No binding" reason.
- `reg-inactive`: there is no binding outside tmux, in print/JSON/RPC modes, or for a non-foreground child.
- `reg-claude`: Claude registers through native hooks. `bin/claude-config.js` only prints a proposed hook config.

## How to get to it (user POV)

- Start Pi inside a tmux pane with the package loaded: `pi -e /absolute/path/to/pi-tmux-continuity`, or through a settings package entry.
- Type `/tmux-binding` in that Pi.
- For Claude: run `node bin/claude-config.js --claude-bin /absolute/path/to/claude`, review the printed JSON, and merge it into Claude settings yourself.

## Driving it with the sandbox harness

Preconditions:

- Launch and Doctor from the skill pass.
- `H="$SB/work/user/histories/A.jsonl"` exists. It is an invented conversation, not a real transcript.

- **Pi registers persistently.** Open a pane and start Pi on the invented conversation. Run `P=$(tmux -S "$S" new-window -dP -F '#{pane_id}' -c "$(dirname "$H")")` then `tmux -S "$S" send-keys -t "$P" "\"$PI_TMUX_SCOPE_PI\" --session '$H'" Enter`. Within about 5 s, `node bin/inspect.js inspect --socket "$S" --json` has a pane `$P` with `status` `live-persistent` and `binding.sessionFile` equal to `$H`.
- **Distinct in one cwd.** Start a second Pi in a new pane in the same directory: run `new-window`, then `send-keys` with `"$PI_TMUX_SCOPE_PI"` and no `--session`. The inspector shows two panes with the same `binding.cwd` and different `binding.sessionId`. The new one is `live-non-restorable`, because its file is not written yet.
- **Inactive outside tmux.** Run `env -u TMUX "$PI_TMUX_SCOPE_PI" -p hi </dev/null`. No pane gains a binding; compare the inspector output before and after.
- **Claude proposal is read-only.** Run `node bin/claude-config.js --claude-bin "$(command -v claude)"`. It exits 0 with JSON on stdout, and `~/.claude/settings.json` has the same mtime before and after.
- **Proof.** Save both inspector outputs and the `claude-config` stdout under `evidence/feature-map/<ts>/registration/`.

## Gotchas

- `/tmux-binding` needs an attached TUI. In the sandbox, prove `reg-selfcheck` by attaching (`env … tmux -f "$CONF" -S "$S" attach`) and typing it. Otherwise report it `verified-unreachable`.
- After changing `src/`, run `npm run build` before testing. Pi loads the generated root `extension.ts`, and `npm test` rejects a stale bundle.
- Wrappers that do not hold the foreground process group (some launchers, `nohup`) are refused on purpose. A missing binding there is correct behavior, not a regression.
- Claude is always `live-non-restorable` in the inspector, because it never reads transcripts. That is expected. Restore uses the exact session ID anyway (see workspace-restore).
- Native Claude registration needs real hooks and auth. Use `node --test test/integration/claude-synthetic.test.js` for the offline path. A native Claude run needs separate approval.
