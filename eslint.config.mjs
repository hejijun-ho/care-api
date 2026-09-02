// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "build/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,cts,mts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // 關掉 ESLint 原生版本，避免跟 TypeScript 版本重複
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "no-control-regex": "off",

      // 使用 TypeScript 版本
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
