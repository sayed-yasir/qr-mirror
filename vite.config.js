import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the app from /<repository-name>/.
// Relative asset URLs keep the same build working on GitHub Pages and locally.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
