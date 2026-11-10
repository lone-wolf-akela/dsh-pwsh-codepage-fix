/**
 * `ctx.shell` provider that fixes the two PowerShell encoding defects in
 * `@deepseek-ai/dsh-pwsh-local`:
 *
 *  1. the encoding preamble was concatenated into the same `-Command` string
 *     as the user command, so any syntax error suppressed it and the parser
 *     error reached the harness in the host ANSI code page while the harness
 *     decoded UTF-8 -> mojibake (and some parse errors were dropped entirely);
 *  2. the preamble set only `[Console]::OutputEncoding`/`$OutputEncoding`, never
 *     `[Console]::InputEncoding`.
 *
 * It extends the sandboxed executor so confinement, sandbox facts, deadlines,
 * background jobs and the tool layer's escalation flow are untouched; only the
 * argv shape and the child environment change. See `plan.js` for the why.
 *
 * @module @lone-wolf-akela/dsh-pwsh-codepage-fix
 */
import { buildEnv, directArgv, usesExternalCodePage, wrappedArgv } from "./plan.js";
import { importCore } from "./core.js";

const { SandboxPwshExecutor } = await importCore("@deepseek-ai/dsh-pwsh-sandbox");

const COMSPEC_FALLBACK = "C:\\Windows\\System32\\cmd.exe";

/** The pwsh executor with the encoding-safe invocation shape. */
export default class PwshCodepageExecutor extends SandboxPwshExecutor {
  /** The command processor used by the wrapped (read-only) shape. */
  get comspec() {
    const value = process.env.ComSpec ?? process.env.COMSPEC;
    return typeof value === "string" && value.length > 0 ? value : COMSPEC_FALLBACK;
  }

  /**
   * The invocation argv. Read-only sessions (ConstrainedLanguage under the
   * stock ACL sandbox) get the cmd+chcp wrapper that supplies UTF-8 from
   * outside; every FullLanguage session keeps one pwsh process.
   */
  argv(spec) {
    return usesExternalCodePage(spec) ? wrappedArgv(this.comspec) : directArgv(this.pwshPath);
  }

  /** Add the command (and wrapped-shape values) to the child environment. */
  spawnSpec(spec, stdoutMaxBytes, signal, argv) {
    const base = super.spawnSpec(spec, stdoutMaxBytes, signal, argv);
    return {
      ...base,
      env: buildEnv(base.env ?? {}, spec.command, this.pwshPath, usesExternalCodePage(spec)),
    };
  }
}
