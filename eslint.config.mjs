import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // AudioWorklet processors run in AudioWorkletGlobalScope, not in a window.
  {
    files: ["public/worklets/**/*.js"],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",
        currentFrame: "readonly",
        currentTime: "readonly",
      },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Windows app is its own npm project, and eval output is generated.
    "desktop/**",
    "eval/results/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
