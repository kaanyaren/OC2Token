import { createRequire } from "node:module";

/**
 * Shared app version resolver. Reads package.json (not hardcoded) so
 * `--version` and the dashboard credit line cannot drift. Falls back to
 * "0.1.4" when the manifest is unreachable (e.g. unusual bundling). Tries
 * both src (`../package.json`) and dist (`../../package.json`) layouts.
 *
 * Lives in its own module importing nothing from the app so both `src/cli.ts`
 * and the dashboard render code can use it without a dependency cycle
 * (`src/cli.ts` imports from `src/output/index.js`).
 */
export function resolveAppVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    for (const candidate of ["../package.json", "../../package.json"]) {
      try {
        const pkg = require(candidate) as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
      } catch {
        // Try the next candidate layout.
      }
    }
  } catch {
    // createRequire itself failed — fall through to the fallback below.
  }
  return "0.1.4";
}

export const APP_VERSION = resolveAppVersion();
