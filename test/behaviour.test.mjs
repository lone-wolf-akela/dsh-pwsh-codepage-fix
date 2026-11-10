import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildEnv, directArgv, wrappedArgv, ENV_COMMAND, ENV_EXE, ENV_BOOTSTRAP } from "../lib/plan.js";

const PWSH = process.env.DSH_PWSH_EXE
  ?? (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe") ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : "pwsh");
const COMSPEC = process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";

/** Run one command through the exact argv/env the plugin produces. */
function run(command, { wrapped = false } = {}) {
  const env = buildEnv(process.env, command, PWSH, wrapped);
  const argv = wrapped ? wrappedArgv(COMSPEC) : directArgv(PWSH);
  const result = spawnSync(argv[0], argv.slice(1), {
    env,
    encoding: "buffer",
    timeout: 120000,
    windowsHide: true,
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  return {
    status: result.status,
    out: stdout.toString("utf8"),
    err: stderr.toString("utf8"),
    rawStdout: stdout,
    rawStderr: stderr,
  };
}

/** UTF-8 must decode the captured bytes losslessly (no replacement chars). */
function assertCleanUtf8(text, label) {
  assert.ok(!text.includes("\uFFFD"), `${label}: replacement characters mean the bytes were not UTF-8: ${JSON.stringify(text)}`);
  new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf8"));
}

for (const wrapped of [false, true]) {
  const mode = wrapped ? "wrapped" : "direct";

  test(`${mode}: syntax error with CJK is readable UTF-8 with a caret`, () => {
    const r = run('$x = "中文错误"; if (', { wrapped });
    assert.equal(r.status, 1);
    assert.match(r.err, /ParserError:/);
    assert.match(r.err, /缺少条件/);
    assert.match(r.err, /在 行:1/);
    assert.match(r.err, /中文错误/);
    assertCleanUtf8(r.err, `${mode} parse error`);
  });

  test(`${mode}: runtime CJK output and errors are UTF-8`, () => {
    const r = run("Write-Output '中文输出'; Write-Error '中文错误'", { wrapped });
    assert.equal(r.status, 1);
    assert.equal(r.out.trim(), "中文输出");
    assert.match(r.err, /中文错误/);
    assertCleanUtf8(r.out + r.err, `${mode} runtime output`);
  });

  test(`${mode}: both console directions are UTF-8 after the bootstrap`, () => {
    const r = run("[Console]::OutputEncoding.WebName; [Console]::InputEncoding.WebName; $OutputEncoding.WebName", { wrapped });
    assert.equal(r.status, 0);
    assert.deepEqual(r.out.trim().split(/\r?\n/u), ["utf-8", "utf-8", "utf-8"]);
  });

  test(`${mode}: exit-code semantics match pwsh -Command`, () => {
    assert.equal(run("cmd /c exit 3", { wrapped }).status, 1);
    assert.equal(run("cmd /c exit 3; Write-Output done", { wrapped }).status, 0);
    assert.equal(run("exit 7", { wrapped }).status, 7);
    assert.equal(run("Write-Error boom; Write-Output ok", { wrapped }).status, 0);
    const thrown = run("throw 'boom'", { wrapped });
    assert.equal(thrown.status, 1);
    assert.match(thrown.err, /boom/u);
  });

  test(`${mode}: the command is removed from the environment`, () => {
    const r = run("Write-Output ('cmd=' + ($null -ne $env:" + ENV_COMMAND + ") + ';exe=' + ($null -ne $env:" + ENV_EXE + ") + ';boot=' + ($null -ne $env:" + ENV_BOOTSTRAP + "))", { wrapped });
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), "cmd=False;exe=False;boot=False");
  });

  test(`${mode}: $PSScriptRoot stays empty like -Command`, () => {
    const r = run('Write-Output "psr=[$PSScriptRoot]"', { wrapped });
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), "psr=[]");
  });

  test(`${mode}: a long command survives the environment transport`, () => {
    const padding = "# " + "x".repeat(24000);
    const r = run(`${padding}\nWrite-Output 'long-ok'`, { wrapped });
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), "long-ok");
  });

  test(`${mode}: trailing comment and here-string commands keep working`, () => {
    assert.equal(run("Write-Output hi\n# trailing comment", { wrapped }).out.trim(), "hi");
    assert.equal(run("Write-Output @'\nhello\n'@", { wrapped }).out.trim(), "hello");
  });
}

test("parser errors on a command ending in an open construct are still reported", () => {
  const r = run("function {");
  assert.equal(r.status, 1);
  assert.match(r.err, /ParserError:/);
  assertCleanUtf8(r.err, "function {");
});
