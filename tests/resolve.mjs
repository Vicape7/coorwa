/**
 * Lets `node --test` load the app's own modules.
 *
 * The app is built by Next, which resolves `./config` and `@/lib/config` without an extension.
 * Node's ESM resolver does neither, so rather than write imports twice or teach the source about
 * the test runner, the runner is taught about the source. Node runs the TypeScript itself from
 * v24, so this hook only has to fix the specifier.
 */
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * A path is only finished if it names an actual file. `./db` names a directory, and Node refuses a
 * directory import outright, so it has to fall through to the index candidates below.
 */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // "@/lib/config" is the tsconfig path alias, and it always points into src.
    if (specifier.startsWith("@/")) {
      const asFile = resolvePath(SRC, specifier.slice(2));
      for (const candidate of [asFile, `${asFile}.ts`, `${asFile}.tsx`, `${asFile}/index.ts`]) {
        if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }

    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const from = dirname(fileURLToPath(context.parentURL));
      const asFile = resolvePath(from, specifier);
      if (!isFile(asFile)) {
        for (const candidate of [`${asFile}.ts`, `${asFile}.tsx`, `${asFile}/index.ts`]) {
          if (isFile(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },
});
