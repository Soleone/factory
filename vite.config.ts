import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";
import { demoApi } from "./scripts/demo";
import { BUILTIN_THEMES } from "./src/components/soleone/theme/palettes";
import { themePlugin } from "./src/components/soleone/theme-vite";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "./src/theme/config";

// Vendored code: shadcn primitives and @soleone registry items. They stay byte-for-byte upstream so
// `shadcn add --overwrite` can update them; `kit check` verifies that.
const vendored = [
  "src/components/ui/**",
  "src/components/soleone/**",
  "src/components/live/**",
  "src/hooks/**",
];

const noBaseUi = {
  group: ["@base-ui/react", "@base-ui/react/*"],
  message:
    "Use a local high-level component from @/components/ui instead of importing Base UI primitives directly.",
};
const noCva = {
  group: ["class-variance-authority"],
  message:
    "Variants live in src/components/variants: wrap the primitive there and import the wrapper.",
};

/** Where `factory serve` listens under `pn dev`; Vite takes the usual 7040 and proxies to it. */
const API = "http://127.0.0.1:7041";

export default defineConfig(({ mode }) => ({
  // The CLI, bundled to dist/cli.mjs. `vp build` then puts the page next to it in dist/web.
  pack: {
    entry: ["src/backend/cli.ts"],
    dts: false,
  },
  plugins: lazyPlugins(() => [
    ...(mode === "demo" ? [demoApi()] : []),
    react(),
    tailwindcss(),
    themePlugin({
      themes: BUILTIN_THEMES,
      defaultTheme: DEFAULT_THEME,
      storageKey: THEME_STORAGE_KEY,
    }),
  ]),
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  build: { outDir: "dist/web" },
  server: {
    port: mode === "demo" ? 7042 : 7040,
    strictPort: true,
    proxy: mode === "demo" ? undefined : { "/api": API, "/runs": API },
  },
  clearScreen: false,
  staged: { "*": "vp check --fix" },
  // release-it writes the changelog in its own style.
  fmt: { ignorePatterns: ["CHANGELOG.md", ...vendored] },
  lint: {
    plugins: ["react", "typescript", "oxc", "unicorn"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }, "@shadcn/lint"],
    ignorePatterns: ["dist/**", ...vendored],
    options: { typeAware: true, typeCheck: true },
    settings: {
      shadcn: {
        ui: "@/components/ui",
        note: "Follow the design tokens and component variants defined in src/index.css and src/components/ui.",
      },
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/rules-of-hooks": "error",
      "react/exhaustive-deps": "warn",
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "no-restricted-imports": ["error", { patterns: [noBaseUi, noCva] }],
    },
    overrides: [
      {
        // Wrappers around stock primitives: the one place that restyles them and adds variants.
        files: ["src/components/variants/**"],
        rules: {
          "shadcn/no-restyle": "off",
          "shadcn/no-arbitrary-values": "off",
          "no-restricted-imports": ["error", { patterns: [noBaseUi] }],
        },
      },
    ],
  },
}));
