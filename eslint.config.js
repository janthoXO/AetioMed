import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig({
  extends: [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
  ],
  ignores: ["dist/", "node_modules/"],
  files: ["src/**/*.ts"],
});
