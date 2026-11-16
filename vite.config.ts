import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  // release-it writes the changelog in its own style.
  fmt: { ignorePatterns: ["CHANGELOG.md"] },
});
