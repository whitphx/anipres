import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    dts({
      tsconfigPath: "./tsconfig.app.json",
    }),
  ],
  build: {
    lib: {
      entry: {
        anipres: path.resolve(__dirname, "src/index.ts"),
        schema: path.resolve(__dirname, "src/schema.ts"),
        "models-and-tracks": path.resolve(
          __dirname,
          "src/models-and-tracks.ts",
        ),
      },
      // ESM-only. Vite's default for multi-entry libs is `["es", "cjs"]`,
      // which would emit `.cjs` artifacts despite `package.json` no
      // longer declaring a `require` resolution. Pin to `["es"]` so
      // the build matches the package's `exports` map.
      formats: ["es"],
      name: "Anipres",
    },
    rollupOptions: {
      external: ["react", "react-dom", "tldraw"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          tldraw: "tldraw",
        },
      },
    },
    sourcemap: true,
  },
});
