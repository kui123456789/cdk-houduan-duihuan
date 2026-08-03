import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const commonRules = {
  ...js.configs.recommended.rules,
  "preserve-caught-error": "off",
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".codegraph/**",
      ".playwright-cli/**",
      ".wrangler/**",
      "output/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.log",
    ],
  },
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...commonRules,
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["src/hooks/**/*.{js,jsx}", "src/components/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: [
      "server/**/*.js",
      "scripts/**/*.mjs",
      "test/**/*.mjs",
      "e2e/**/*.js",
      "*.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: commonRules,
  },
  {
    files: ["worker/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.worker, ...globals.es2022 },
    },
    rules: commonRules,
  },
];
