import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8")
);
const dist = path.join(root, "dist");
const stage = path.join(dist, ".staging");
const archive = path.join(
  dist,
  `bili-cdn-switcher-v${manifest.version}.zip`
);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await rm(archive, { force: true });

for (const file of ["manifest.json", "LICENSE", "PRIVACY.md", "README.md"]) {
  await copyFile(path.join(root, file), path.join(stage, file));
}

await cp(path.join(root, "src"), path.join(stage, "src"), {
  recursive: true
});
await cp(path.join(root, "assets", "icons"), path.join(stage, "assets", "icons"), {
  recursive: true
});

const result = spawnSync("zip", ["-X", "-q", "-r", archive, "."], {
  cwd: stage,
  encoding: "utf8"
});
if (result.status !== 0) {
  throw new Error(result.stderr || "zip failed");
}

const bytes = await readFile(archive);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await rm(stage, { recursive: true, force: true });

console.log(path.relative(root, archive));
console.log(`size: ${bytes.length} bytes`);
console.log(`sha256: ${sha256}`);
