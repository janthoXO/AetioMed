import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist/**", "client"]),
  {
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    files: ["src/**/*.ts"],
  },
]);
