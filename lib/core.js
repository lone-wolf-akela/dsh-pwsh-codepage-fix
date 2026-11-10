/**
 * Reach harness packages from a plugin that lives outside the app bundle.
 *
 * The harness ships inside `resources/app.asar`, which only Electron's patched
 * `fs` can read; plain Node cannot import a module from it. The host process is
 * Electron, so a `createRequire` rooted at the harness `node_modules` can
 * resolve the package, and the resolved file URL can be imported normally.
 * Importing by the same file URL the harness loader used keeps a single module
 * instance (the service class identity must match).
 *
 * @module @lone-wolf-akela/dsh-pwsh-codepage-fix/core
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

/** Candidate harness module roots, most specific first. */
export function coreModuleRoots() {
  const resources = typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
    ? process.resourcesPath
    : path.join(path.dirname(process.execPath), "resources");
  return [
    path.join(resources, "app.asar", "dsh", "node_modules"),
    path.join(resources, "app.asar", "node_modules"),
    path.join(resources, "app.asar.unpacked", "dsh", "node_modules"),
  ].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

const cache = new Map();

/**
 * Import one harness package by name from inside the app bundle.
 * @param specifier - a bare package name the harness ships.
 * @returns the imported module namespace.
 */
export async function importCore(specifier) {
  const cached = cache.get(specifier);
  if (cached !== undefined) return cached;
  const failures = [];
  for (const root of coreModuleRoots()) {
    try {
      const resolved = createRequire(path.join(root, "noop.js")).resolve(specifier);
      const module = await import(pathToFileURL(resolved).href);
      cache.set(specifier, module);
      return module;
    } catch (error) {
      failures.push(`${root}: ${error?.code ?? ""} ${error?.message ?? error}`);
    }
  }
  throw new Error(`dsh-pwsh-codepage-fix: cannot resolve ${specifier} from the harness installation (${failures.join(" | ")})`);
}
