// Use existing host/compiler declarations without installing a second Pi runtime.
// Usage: node test/typecheck.js /absolute/typescript/lib/typescript.js /absolute/pi-package
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
const [compiler, host] = process.argv.slice(2);
if (!compiler || !host || !isAbsolute(compiler) || !isAbsolute(host)) {
  throw new Error("Supply absolute paths to typescript/lib/typescript.js and the installed Pi package");
}
const ts = createRequire(import.meta.url)(compiler);
const program = ts.createProgram([resolve("src/extension.ts"), resolve("test/fixtures/lifecycle.ts")], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true, strict: true, allowJs: true, checkJs: false, skipLibCheck: true, types: ["node"],
  typeRoots: [join(host, "node_modules/@types")],
  paths: { "@earendil-works/pi-coding-agent": [join(host, "dist/index.d.ts")] }
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => "\n"
  }));
  process.exitCode = 1;
} else console.log("TypeScript adapter/fixture check passed (JS dependencies inferred, not checkJs-audited).");
