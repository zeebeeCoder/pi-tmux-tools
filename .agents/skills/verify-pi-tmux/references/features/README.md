# pi-tmux-continuity feature map

This is the maintained list of what pi-tmux-continuity does for a user, and how to prove each part. Use it with [the verify-pi-tmux skill](../../SKILL.md), which covers launch, doctor, driving conventions, evidence and cleanup. The README's module table covers how the code works; this map does not.

The product has two halves. **Live:** each Pi or Claude says which tmux pane it owns, and you can inspect those panes and jump between them. **Durable:** a managed workspace (one tmux server) keeps its layout and exact agent conversations, and gets them back when the server starts again after a crash, `kill-server` or reboot.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. Four H2 sections follow, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with the sandbox harness` (starting with `Preconditions:`), and `Gotchas`. Leave implementation details out. Name only user paths, stable handles, required state, commands and observable proof. Every entry point listed must be driven, or reported unreachable, before the feature counts as covered.

## Features

- [Exact agent registration](./exact-registration.md): each Pi or Claude binds its exact conversation to its own pane, with the `/tmux-binding` self-check and the Claude hook proposal.
- [Read-only inspection](./inspect.md): `inspect` and `display` report which pane holds which conversation and whether it is restorable.
- [Live agent picker](./agent-picker.md): a popup to filter, sort and jump to any agent on the current server.
- [Managed workspace: adopt and save](./workspace-save.md): opt in with `prefix C-s`, which also saves; detach and autosave also save; badge and title.
- [Managed workspace: restore](./workspace-restore.md): when the server starts, rebuild the layout, resume the exact agents and report gaps.

## Coverage

- Driven live on 2026-10-22 (macOS, tmux 3.5a, Pi 1.1.0): inspect, workspace-save, and the Crash, Start and Reload steps of workspace-restore. The exact-registration and agent-picker recipes have not been driven yet.
- No automated recipe covers native Claude resume or a real reboot. Both have been checked only by manual drills. Report them as `verified-unreachable` unless a separately approved run covers them.
