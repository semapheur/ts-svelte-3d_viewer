import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
//import { viteSingleFile } from "vite-plugin-singlefile";

const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [svelte(), glsl()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
});
