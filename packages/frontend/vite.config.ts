import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          if (!path.includes("/node_modules/")) return;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return "react";
          if (/\/node_modules\/antd\//.test(path)) return "antd";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/media": "http://127.0.0.1:8787",
      "/resume": "http://127.0.0.1:8787",
    },
  },
});
