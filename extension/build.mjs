// Bundles each extension entry point with esbuild and copies the static files into dist/ ("Load unpacked" target).
import { context, build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import process from "node:process";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/popup.ts",
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
for (const file of ["manifest.json", "popup/popup.html", "popup/popup.css"]) {
  await cp(`src/${file}`, `dist/${file.split("/").at(-1)}`);
}

if (watch) {
  await (await context(options)).watch();
} else {
  await build(options);
}
