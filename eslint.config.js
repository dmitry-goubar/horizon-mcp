// @ts-check
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config. Type-aware linting is intentionally off: the recommended rule set
// catches real issues without requiring a tsconfig project, keeping lint fast.
// eslint-config-prettier disables stylistic rules so ESLint and Prettier never fight.
export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "eslint.config.js"] },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);
