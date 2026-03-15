import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

const distDir = path.resolve(__dirname, "dist");

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
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "Anipres",
      fileName: "anipres",
    },
    outDir: distDir,
    emptyOutDir: true,
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
