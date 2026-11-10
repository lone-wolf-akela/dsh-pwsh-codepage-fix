import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOTSTRAP,
  ENV_BOOTSTRAP,
  ENV_COMMAND,
  ENV_EXE,
  PWSH_FLAGS,
  WRAPPED_CHAIN,
  buildEnv,
  checkInvariants,
  directArgv,
  usesExternalCodePage,
  wrappedArgv,
} from "../lib/plan.js";

test("bootstrap and wrapper obey the transport invariants", () => {
  assert.deepEqual(checkInvariants(), []);
  assert.ok(!BOOTSTRAP.includes("\n"), "bootstrap must stay single-line");
  assert.ok(!/["%&|<>^!]/u.test(BOOTSTRAP), "bootstrap must survive a cmd expansion");
  assert.ok(!WRAPPED_CHAIN.includes('"'), "wrapper chain must be quote-free");
});

test("bootstrap defers parsing and pins both directions", () => {
  assert.ok(BOOTSTRAP.includes("Invoke-Expression"), "user text must be parsed after the setup");
  assert.ok(BOOTSTRAP.includes("[Console]::OutputEncoding"), "output encoding must be pinned");
  assert.ok(BOOTSTRAP.includes("[Console]::InputEncoding"), "input encoding must be pinned");
  assert.ok(BOOTSTRAP.includes("ConstrainedLanguage"), "CL must be detected before forbidden APIs run");
  assert.ok(BOOTSTRAP.includes("Write-Error"), "CL must render parse errors through a cmdlet (Console writers are forbidden there)");
  assert.ok(BOOTSTRAP.includes("[char]10"), "exit-code epilogue must not need a literal newline");
  assert.ok(BOOTSTRAP.includes("if (-not $?) { exit 1 }"), "native/soft failures must keep exit code 1");
});

test("direct argv is the shipped shape with the bootstrap", () => {
  assert.deepEqual(directArgv("C:\\pwsh.exe"), ["C:\\pwsh.exe", ...PWSH_FLAGS, "-Command", BOOTSTRAP]);
});

test("wrapped argv goes through cmd with a quoted-free chain", () => {
  const argv = wrappedArgv("C:\\Windows\\System32\\cmd.exe");
  assert.equal(argv[0], "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(argv.slice(1, 4), ["/d", "/s", "/c"]);
  assert.equal(argv.length, 5);
  assert.ok(argv[4].startsWith("chcp 65001>nul 2>nul & "));
  assert.ok(argv[4].includes(`%${ENV_EXE}%`));
  assert.ok(argv[4].includes(`%${ENV_BOOTSTRAP}%`));
});

test("buildEnv carries the command and only the wrapped shape adds quoted values", () => {
  const direct = buildEnv({ A: "1" }, "Get-Date", "C:\\pwsh.exe", false);
  assert.equal(direct.A, "1");
  assert.equal(direct[ENV_COMMAND], "Get-Date");
  assert.equal(direct[ENV_EXE], undefined);
  assert.equal(direct[ENV_BOOTSTRAP], undefined);

  const wrapped = buildEnv({}, 'Write-Output "x"', "C:\\Program Files\\PowerShell\\7\\pwsh.exe", true);
  assert.equal(wrapped[ENV_EXE], '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"');
  assert.equal(wrapped[ENV_BOOTSTRAP], `"${BOOTSTRAP}"`);
});

test("only stock read-only mode needs the external code page", () => {
  assert.equal(usesExternalCodePage({ sandboxPolicy: { mode: "read-only" } }), true);
  assert.equal(usesExternalCodePage({ sandboxPolicy: { mode: "workspace-write" } }), false);
  assert.equal(usesExternalCodePage({ sandboxPolicy: { mode: "danger-full-access" } }), false);
  assert.equal(usesExternalCodePage({}), false);
  assert.equal(usesExternalCodePage(undefined), false);
});
