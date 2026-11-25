// Bundles each extension entry point with esbuild and copies the static files into dist/ ("Load unpacked" target).
import { context, build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import process from "node:process";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/popup.ts",
    offscreen: "src/offscreen/offscreen.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const file of ["manifest.json", "popup/popup.html", "popup/popup.css", "offscreen/offscreen.html"]) {
  await cp(`src/${file}`, `dist/${file.split("/").at(-1)}`);
}
// Icons: the PNGs scripts/render-icons.sh renders from the SVG sources (committed, so the build needs no renderer).
await mkdir("dist/icons", { recursive: true });
for (const size of [16, 32, 48, 128])
  await cp(`src/icons/icon-${String(size)}.png`, `dist/icons/icon-${String(size)}.png`);

// Injected with executeScript({ files }), which runs classic scripts: bundled as an IIFE, not a module.
const content = {
  ...options,
  entryPoints: { capture: "src/content/capture.ts", overlay: "src/content/overlay.ts" },
  format: "iife",
};

if (watch) {
  await Promise.all([options, content].map(async (o) => (await context(o)).watch()));
} else {
  await Promise.all([build(options), build(content)]);
}
