import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./", // relative assets so the built site works on GitHub Pages / any subpath
  build: {
    // Static build lands in repo-root docs/ so GitHub Pages (source=/docs) serves it.
    outDir: "../docs",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
