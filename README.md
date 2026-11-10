# @lone-wolf-akela/dsh-pwsh-codepage-fix

Fixes two encoding defects in the DeepSeek Harness `pwsh` tool
(`@deepseek-ai/dsh-pwsh-local`):

1. **Syntax errors arrived as mojibake.** The shipped executor prepends an
   encoding preamble to the user command inside the *same* `-Command` string.
   PowerShell parses that whole string before running any of it, so a syntax
   error also skipped the preamble and the parser error was written with the
   process's startup output encoding (ANSI on a zh-CN host) while the harness
   decodes UTF-8. Some parse errors were dropped entirely.
2. **`[Console]::InputEncoding` was never set.** Only
   `[Console]::OutputEncoding` and `$OutputEncoding` were pinned, leaving stdin
   decoding on the ambient code page.

It also fixes a third, worse case found while validating: under the stock
Windows ACL sandbox, **read-only** commands run in PowerShell
**ConstrainedLanguage**, where the old preamble's
`[System.Text.UTF8Encoding]::new($false)` is refused — every call emitted three
mojibake `InvalidOperation` lines and all non-ASCII output stayed ANSI.

## What it does

The bundle replaces the `pwsh-sandbox` shell row with a subclass of
`@deepseek-ai/dsh-pwsh-sandbox` that only changes the argv shape and the child
environment; confinement, sandbox facts, deadlines, background jobs and the
tool layer's escalation flow are inherited unchanged.

- The user command travels in an environment variable (Windows environment
  variables are Unicode, so no code page is involved) and is deleted from the
  environment before user code runs.
- A fixed ASCII bootstrap sets `$OutputEncoding`,
  `[Console]::OutputEncoding` and `[Console]::InputEncoding` to UTF-8, then
  hands the command to `Invoke-Expression` — so parsing happens *after* the
  encoding setup and parser errors are emitted as UTF-8 with line/column/caret.
  In FullLanguage sessions the command is pre-parsed once (`scriptblock::Create`)
  so the added `if (-not $?) { exit 1 }` exit-code epilogue can never swallow an
  unterminated construct; the epilogue keeps the shipped `-Command` exit-code
  semantics (native failure → 1, `exit N` → N, `throw` → 1, soft error followed
  by success → 0).
- **Read-only** sessions (ConstrainedLanguage) get the encoding from outside the
  process instead: the argv prefixes `cmd /d /s /c "chcp 65001>nul 2>nul & …"`,
  so the pwsh that runs starts on a UTF-8 console code page — both output and
  input are UTF-8 from the first line, and the bootstrap skips the setters that
  ConstrainedLanguage forbids. The pwsh path and bootstrap reach cmd through
  quoted environment variables so the command line itself carries no quote.
- **Workspace-write / copy-on-write / full-access** stay FullLanguage and keep a
  single pwsh process (no extra process, no temp files, no change to what
  timeout termination observes).

## Install

```powershell
plugin_manager install_bundle target "<path-to-this-directory>"
```

or with the CLI:

```powershell
dsh plugin --profile <profile> add "<path-to-this-directory>"
```

The profile's `package.json` must list the bundle in `dsh.profile.bundles`;
`install_bundle` does that. Restart the Harness if the shell row does not reload
live.

## Verify

```powershell
# syntax error with CJK: should be readable UTF-8 with a caret, exit 1
pwsh tool:  $x = "中文错误"; if (

# both directions pinned
$ExecutionContext.SessionState.LanguageMode; [Console]::OutputEncoding.WebName; [Console]::InputEncoding.WebName
```

Tests:

```powershell
node --test test/plan.test.mjs test/behaviour.test.mjs
```

## Known limits

- A host policy that forces ConstrainedLanguage in **workspace-write** (not the
  default) also refuses the console setters; only the read-only external
  code-page path covers that, so such a host keeps ANSI output in
  workspace-write.
- In ConstrainedLanguage the pre-parse validation is unavailable
  (`scriptblock::Create` is forbidden). Parse errors are still rendered with
  line/column/caret — through a `Write-Error` record, because the `Console`
  writers are forbidden there too — but a command that ends in an unterminated
  construct can have its reported line shifted by the appended exit-code line;
  the message itself stays correct.
- The read-only wrapper needs a console whose code page `chcp` can change
  (the normal ACL runner case). Where that is unavailable the read-only path
  degrades to the stock behaviour.

## Files

- `lib/plan.js` — bootstrap, argv/env builders, invariants.
- `lib/core.js` — resolves harness packages from inside `app.asar`.
- `lib/index.js` — the `ctx.shell` executor subclass.
- `cordis.patch.yml` — disables `pwsh-sandbox`, inserts this bundle's row.
- `locale/en.json`, `locale/zh.json` — Plugin Manager title and description.
- `icon.svg` — Plugin Manager icon.
- `test/` — invariant and real-pwsh behaviour tests.
