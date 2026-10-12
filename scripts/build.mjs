import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Publish only the application. Tests, source backups and local tooling cannot
// accidentally become part of the Pages artifact.
const assets = [
  "index.html",
  "styles.css",
  "app.js",
  "core.js",
  "audio.js",
  "data.js",
  "icon.svg",
  "manifest.webmanifest",
  "sw.js",
];
const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const destination = resolve(root, "dist");
if (dirname(destination) !== root || destination === root)
  throw new Error("Unsafe build destination.");
try {
  if ((await lstat(destination)).isSymbolicLink())
    throw new Error("Build destination must not be a symbolic link.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// Read and validate every required source before replacing any previous build.
const files = await Promise.all(
  assets.map(async (name) => {
    const path = join(root, name);
    if (!(await lstat(path)).isFile())
      throw new Error(`Expected a regular file: ${name}`);
    return [name, await readFile(path)];
  }),
);
const hash = createHash("sha256");
for (const [name, contents] of files)
  hash.update(name).update("\0").update(contents).update("\0");
const buildId = hash.digest("hex").slice(0, 16);
const swSource = files.find(([name]) => name === "sw.js")[1].toString("utf8");
const cacheDeclaration =
  /(^\s*const\s+CACHE\s*=\s*['"])wanglu-personal-[^'"]+(['"])/m;
if (!cacheDeclaration.test(swSource) && !swSource.includes("__BUILD_ID__")) {
  throw new Error(
    "Service worker cache declaration was not found; refusing to ship an unversioned cache.",
  );
}
const builtWorker = swSource
  .replace(
    cacheDeclaration,
    (_match, prefix, quote) => `${prefix}wanglu-personal-${buildId}${quote}`,
  )
  .replaceAll("__BUILD_ID__", buildId);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await Promise.all(
  files.map(([name, contents]) =>
    writeFile(
      join(destination, name),
      name === "sw.js" ? builtWorker : contents,
    ),
  ),
);
await writeFile(join(destination, ".nojekyll"), "");
console.log(`Built ${assets.length} application assets in dist/ (${buildId}).`);
