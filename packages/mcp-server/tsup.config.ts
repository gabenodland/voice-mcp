import { defineConfig } from "tsup";
import path from "path";

export default defineConfig({
  entry: ["src/index.ts", "src/backend-entry.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  external: ["audify", "mpg123-decoder", "koffi"],
  esbuildOptions(options) {
    options.alias = {
      "@voice-mcp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    };
  },
});
