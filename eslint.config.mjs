import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output, none of it written here: the bundled worker, wrangler's state and the compiled
    // program. Linting a build is thousands of findings about code nobody can fix.
    ".open-next/**",
    ".wrangler/**",
    "target/**",
  ]),
]);

export default eslintConfig;
