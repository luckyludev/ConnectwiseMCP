import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const pathFromUrl = (value: URL) => decodeURIComponent(value.pathname);
const root = pathFromUrl(new URL("./ui/attachment-uploader", import.meta.url));
const outDir = pathFromUrl(new URL("./.attachment-app-dist", import.meta.url));

export default defineConfig({
  root,
  plugins: [viteSingleFile()],
  build: {
    outDir,
    emptyOutDir: true,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: pathFromUrl(
        new URL("./ui/attachment-uploader/index.html", import.meta.url),
      ),
    },
  },
});
