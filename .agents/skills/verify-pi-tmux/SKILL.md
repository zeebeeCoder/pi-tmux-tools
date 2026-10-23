---
name: verify-pi-tmux
description: Verify pi-tmux-continuity's user-facing behavior (exact Pi/Claude pane registration, the read-only inspector, the live agent picker, managed-workspace save and restore) by driving real tmux servers and offline Pi in a guarded sandbox, then capturing evidence. Use after changing one of these features, when proving a delegated change, reproducing a reported restore or picker problem, or checking a new platform, tmux or Pi version. Never drives the user's real tmux servers.
---

# Verify pi-tmux-continuity

Drive the product the way a user does, on sandbox tmux servers only, and leave evidence behind. The feature map in [references/features/README.md](references/features/README.md) has one recipe per feature. Read the index and pick the matching recipe; this file covers launching, checking, driving conventions, evidence and cleanup.

The sandbox runner puts a guard `tmux` first on `PATH`. The guard refuses any socket outside the sandbox, and refuses `-L` outright. A script that kills the default socket kills the user's real server and every agent in it, so every command in this skill targets an explicit sandbox socket.

## Launch

Run from the repository root (`REPO=$PWD`). Node >=22.18, Python 3, tmux, Pi 1.1.0+ and fzf must be installed. If `command -v pi` resolves to a mise/asdf shim, first set `PI_TMUX_TEST_PI=$(mise which pi)`. After any `src/` change, run `npm run build` first; Pi loads the generated root `extension.ts`.

1. Run `node test/manual/verify-scopes.js --keep`. Ready means the final line reads `N/N checks passed` and a `Kept sandbox` block follows. If any line says `FAIL`, record those lines with the run's evidence before going on.
2. From that block, set `SB` to the sandbox path and `export` the five `VAR='…'` assignments on the `attach:` line: `PATH`, `TMUX_TMPDIR`, `PI_TMUX_SCOPES_HOME`, `PI_TMUX_SCOPE_PI` and `PI_CODING_AGENT_DIR`. Then `unset TMUX`.
3. Set `S="$TMUX_TMPDIR/tmux-$(id -u)/user-r"`, `CONF="$SB/user.conf"` and `W="$PI_TMUX_SCOPES_HOME/user-r"`. With `--no-user-config`, use `fixture-r` and `$SB/fixture.conf`.
4. The kept `user-r` server is the run's final state. It was started with `PI_TMUX_SCOPE_FRESH=1`, so no agent is running. Its home `$W` is managed, and its latest recovery point holds a Pi. Run the **Crash** and **Start** steps of [workspace-restore](references/features/workspace-restore.md). The result is a workspace with a live, registered Pi, which every other recipe needs.

## Doctor

Run this before the first drive, after any failed drive, and whenever something looks off. Every line must hold.

- `command -v tmux` prints `$SB/bin/tmux`, the guard shim.
- `tmux -S "$S" display -p '#{pid} #{socket_path}'` exits 0, and the path starts with `$SB/run/`.
- `tmux -S "/tmp/tmux-$(id -u)/default" ls` exits `97` with `sandbox tmux guard: refused target`.
- `test -f "$W/workspace.json"` succeeds, so the workspace is managed.

## Drive

- Address every server with `-S <path inside $SB/run>`. Never use `-L`.
- Start a sandbox server with `tmux -u -f "$CONF" -S <socket> …`. That loads `tmux/scope.conf` the same way a real config does.
- Run Pi only as `"$PI_TMUX_SCOPE_PI"`. It is offline, with no tools, no model requests and a private agent directory. Its conversations are invented, under `$SB/work/user/histories/`.
- Prefix keys need an attached client. The harness instead calls the entry point that the key binding runs: `node bin/tmux-scope.js <save|detach|autosave|restore> "$S"`. Each recipe says which entry point stands in for which key.
- To reach paths that only a person can drive, such as `/tmux-binding` or the picker popup, attach a real terminal with the full `attach:` line that `--keep` printed. Then screenshot it.
- Treat every command as literal. The JSON fields the recipes name (`status`, `binding.sessionFile`, `launched[].verified`) are stable handles.

The real-target check is `node test/manual/drill.js before|after`. A human runs it, against their own workspace, and ends and restarts the server themselves. The drill is read-only; never script the server restart.

## Evidence

- Put artifacts in `evidence/feature-map/<UTC timestamp>/<feature-id>/`. Git ignores that folder.
- CLI proof includes the command, stdout, stderr and exit code. Save proof is the workspace home's files, `latest.json` and `snapshots/*.json`, not the status-line message. Restore proof is `last-restore.json` **plus** a second, independent `node bin/inspect.js inspect --socket "$S" --json` read.
- Record the feature ID and the entry point used with every artifact.
- A path that needs a real attached terminal, native Claude or a reboot is reported as `verified-unreachable`, with the unmet precondition. Do not report it as verified through the harness stand-in.
- The smoke runner's own report is written to `evidence/scopes/<timestamp>/report.json`. Cite it.

## Cleanup

Run `node test/manual/verify-scopes.js --cleanup "$SB"`. It stops every sandbox server, refuses to run on anything that isn't a smoke sandbox, and deletes `$SB`. Evidence under `evidence/` survives; check that it is still there afterwards. Run cleanup after a failed iteration as well. Never kill tmux or Pi by process name.

## Keeping the map honest

When behavior changes on purpose, update the matching recipe in the same change. A human approves that recipe change. If a recipe fails, decide which kind of problem it is. Doc drift means the map is wrong: fix the map. A harness gap means the feature works but cannot be driven: fix the harness. A product regression means the feature is broken: report it, and do not weaken the recipe to make it pass.
