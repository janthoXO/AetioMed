import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**"]),
  {
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    ignores: ["dist/**", "node_modules/**"],
    files: ["src/**/*.ts"],
  },
]);
