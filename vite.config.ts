import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [
    svelte(),
    //viteSingleFile({
    //  inlinePattern: ["**/*.js", "**/*.css", "**/*.worker.js"],
    //  removeViteModuleLoader: true,
    //}),
  ],
  //build: {
  //  rollupOptions: {
  //    output: {
  //      manualChunks: undefined,
  //    },
  //  },
  //  cssCodeSplit: false,
  //},
  optimizeDeps: {
    exclude: ["three-mesh-bvh"],
  },
})
