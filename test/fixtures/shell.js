import { existsSync } from "node:fs";

// An ordinary interactive shell without user or global startup files: zsh where installed
// (the macOS default), otherwise bash. Both honour PS1 from the environment.
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(p => existsSync(p));
const bash = ["/bin/bash", "/usr/bin/bash"].find(p => existsSync(p));
if (!zsh && !bash) throw new Error("No zsh or bash for the interactive shell tests");
export const interactiveShell = zsh ? zsh + " -dfi" : bash + " --norc --noprofile -i";
