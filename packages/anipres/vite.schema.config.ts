import path from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

const distDir = path.resolve(__dirname, "dist");

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: "./tsconfig.app.json",
      include: ["src/schema.ts", "src/shapes/**/*.ts"],
      outDir: distDir,
      insertTypesEntry: false,
      rollupTypes: false,
    }),
  ],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/schema.ts"),
      formats: ["es"],
      fileName: () => "schema.js",
    },
    outDir: distDir,
    emptyOutDir: false,
    rollupOptions: {
      external: ["@tldraw/tlschema", "@tldraw/validate"],
    },
    sourcemap: true,
  },
});
