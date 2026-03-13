import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Font from "vite-plugin-font";

export default defineConfig({
  plugins: [react(), Font.vite()],
  base: "", // https://vite.dev/guide/build#relative-base
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        ws: true,
      },
    },
  },
});
