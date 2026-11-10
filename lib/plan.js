/**
 * Pure planning helpers for the pwsh codepage fix.
 *
 * Everything that decides the argv/env shape lives here so it can be tested
 * with plain Node, without Electron, asar, or a harness profile:
 *
 *  - `BOOTSTRAP` is the fixed, ASCII, quote-free PowerShell prelude the plugin
 *    hands to `pwsh -Command` instead of the shipped `ENCODING_PREAMBLE`;
 *  - `directArgv()`/`wrappedArgv()` are the two spawn shapes;
 *  - `buildEnv()` attaches the user command (and, for the wrapped shape, the
 *    two quote-carrying values cmd expands).
 *
 * WHY THE COMMAND TRAVELS IN AN ENVIRONMENT VARIABLE
 *
 * The shipped executor appends the user command to the encoding preamble inside
 * ONE `-Command` argument. PowerShell parses that whole string before running
 * any of it, so a syntax error suppresses the preamble too and the parser error
 * is emitted with the process's *startup* output encoding (ANSI on a zh-CN
 * host), which the harness then decodes as UTF-8 -> mojibake.
 *
 * The bootstrap is parsed instead, sets the encodings, and only then hands the
 * user text to `Invoke-Expression`. Environment variables are Unicode on
 * Windows, so the command text never passes through a code page; it is removed
 * from the environment before user code runs. The same transport keeps the
 * command out of the command line, which matters for the wrapped shape below.
 *
 * WHY READ-ONLY MODE GETS A DIFFERENT SPAWN SHAPE
 *
 * The stock Windows ACL sandbox runs read-only commands under a write-restricted
 * token; PowerShell 7 enters ConstrainedLanguage there. In ConstrainedLanguage
 * every console-encoding setter (`[Console]::OutputEncoding`,
 * `[Console]::InputEncoding`) is refused, so no in-process setup can make output
 * UTF-8. The encoding therefore has to be provided from outside, before pwsh
 * starts: the argv prefixes `cmd /c "chcp 65001>nul 2>nul & ..."` so the pwsh
 * this shell spawns starts on a UTF-8 console code page (both its output and
 * input encodings are then UTF-8 from the first line). `cmd` expands the pwsh
 * path and the bootstrap from environment variables, so the command line itself
 * contains no quote for Node's argv quoting to mangle.
 *
 * Workspace-write / copy-on-write / full-access sessions are FullLanguage, so
 * the direct shape is used and the bootstrap sets the encodings in-process:
 * no extra process, no temp files, no change to the process tree that timeout
 * termination observes.
 *
 * @module @lone-wolf-akela/dsh-pwsh-codepage-fix/plan
 */

/** Env var carrying the exact command text for one execution. */
export const ENV_COMMAND = "__DSH_PWSH_CMD";
/** Env var carrying the quoted pwsh executable (wrapped shape only). */
export const ENV_EXE = "__DSH_PWSH_EXE";
/** Env var carrying the quoted bootstrap (wrapped shape only). */
export const ENV_BOOTSTRAP = "__DSH_PWSH_BOOTSTRAP";

/** Fixed pwsh flags the shipped executor used; kept for behavioural parity. */
export const PWSH_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

/**
 * The prelude itself. Constraints, each load-bearing:
 *
 *  - ASCII only, and free of `"` `%` `&` `|` `<` `>` `^` `!`: in the wrapped
 *    shape it arrives through a cmd `%VAR%` expansion.
 *  - Single line: cmd cannot receive a newline through `%VAR%` safely.
 *  - Never touches a ConstrainedLanguage-forbidden API outside a guard: the
 *    console setters AND the `[scriptblock]::Create` validation only run when
 *    the session reports FullLanguage.
 *  - Does not append the exit-code epilogue blindly; it validates the parse
 *    first in FullLanguage so the epilogue line can never become part of an
 *    unterminated construct (which would misplace the parser error). In
 *    ConstrainedLanguage the epilogue is appended to the user text and that
 *    edge case can misplace the reported line; the message itself stays valid.
 */
export const BOOTSTRAP = [
  "$__dshLM = $ExecutionContext.SessionState.LanguageMode",
  "try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
  "if ($__dshLM -ne 'ConstrainedLanguage') { try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {} }",
  `$__dshC = $env:${ENV_COMMAND}`,
  `Remove-Item Env:${ENV_COMMAND},Env:${ENV_EXE},Env:${ENV_BOOTSTRAP} -ErrorAction SilentlyContinue`,
  "if ($__dshLM -ne 'ConstrainedLanguage') { try { $null = [scriptblock]::Create($__dshC) } catch { $__dshE = $_.Exception; while ($null -ne $__dshE.InnerException) { $__dshE = $__dshE.InnerException }; try { if ($__dshE.Errors.Count -gt 0) { [Console]::Error.WriteLine('ParserError: '); foreach ($__dshP in $__dshE.Errors) { [Console]::Error.WriteLine([string]$__dshP) }; exit 1 } } catch {} } }",
  "try { Invoke-Expression ($__dshC + [char]10 + 'if (-not $?) { exit 1 }') } catch { $__dshE = $_.Exception; $__dshHandled = $false; try { $__dshErrs = $__dshE.Errors; if ($null -ne $__dshErrs -and $__dshErrs.Count -gt 0) { $__dshText = ''; foreach ($__dshP in $__dshErrs) { $__dshText = $__dshText + [string]$__dshP + [char]10 }; if ($__dshLM -eq 'ConstrainedLanguage') { Write-Error -Message $__dshText -ErrorAction Continue } else { [Console]::Error.WriteLine('ParserError: '); [Console]::Error.WriteLine($__dshText) }; $__dshHandled = $true } } catch {}; if ($__dshHandled) { exit 1 }; throw }",
].join("; ");

/**
 * The cmd command line used by the wrapped (read-only) shape. It deliberately
 * contains no quote characters: the quoted executable and the quoted bootstrap
 * are expanded from the environment, and Node's CreateProcess quoting would
 * otherwise escape embedded quotes into literal backslashes for cmd.
 */
export const WRAPPED_CHAIN = `chcp 65001>nul 2>nul & %${ENV_EXE}% ${PWSH_FLAGS.join(" ")} -Command %${ENV_BOOTSTRAP}%`;

/** Characters a cmd `%VAR%` expansion of the bootstrap cannot carry safely. */
const CMD_UNSAFE = /["%&|<>^!\r\n]/u;
/** The wrapper chain intentionally uses `&` and `>`; only quotes/newlines break it. */
const CHAIN_UNSAFE = /["\r\n]/u;

/**
 * Whether one execution needs the external (pre-spawn) code-page setup.
 * Only the stock ACL read-only mode runs ConstrainedLanguage; every other mode
 * is FullLanguage, where the bootstrap sets encodings in-process.
 * @param spec - the resolved execution spec.
 * @returns true when the argv must be the cmd+chcp wrapper.
 */
export function usesExternalCodePage(spec) {
  return spec?.sandboxPolicy?.mode === "read-only";
}

/**
 * Direct shape: one pwsh process with the bootstrap as its command.
 * @param pwshPath - the resolved pwsh executable.
 * @returns the exact argv.
 */
export function directArgv(pwshPath) {
  return [pwshPath, ...PWSH_FLAGS, "-Command", BOOTSTRAP];
}

/**
 * Wrapped shape: `cmd` sets the console code page, then runs pwsh.
 * @param comspec - the command processor to use.
 * @returns the exact argv.
 */
export function wrappedArgv(comspec) {
  return [comspec, "/d", "/s", "/c", WRAPPED_CHAIN];
}

/**
 * Environment for one spawn. The user command always rides in
 * {@link ENV_COMMAND}; the wrapped shape adds the two quoted values cmd expands.
 * @param base - the environment the executor already resolved.
 * @param command - the exact command text.
 * @param pwshPath - the resolved pwsh executable.
 * @param wrapped - whether this spawn uses the wrapped shape.
 * @returns a new environment object.
 */
export function buildEnv(base, command, pwshPath, wrapped) {
  const env = { ...base, [ENV_COMMAND]: command };
  if (wrapped) {
    env[ENV_EXE] = `"${pwshPath}"`;
    env[ENV_BOOTSTRAP] = `"${BOOTSTRAP}"`;
  }
  return env;
}

/**
 * Preconditions the package itself asserts in its tests: the bootstrap must be
 * usable both as a direct `-Command` argument and inside the cmd wrapper, and
 * the wrapper chain must stay quote-free.
 * @returns the violations found (empty when the invariants hold).
 */
export function checkInvariants() {
  const violations = [];
  if (CMD_UNSAFE.test(BOOTSTRAP)) violations.push("BOOTSTRAP contains a cmd-unsafe character");
  if (BOOTSTRAP.includes("\n")) violations.push("BOOTSTRAP is multi-line");
  if (CHAIN_UNSAFE.test(WRAPPED_CHAIN)) violations.push("WRAPPED_CHAIN contains a double quote or newline");
  return violations;
}
