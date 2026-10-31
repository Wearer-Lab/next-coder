import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVersion = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
const scratch = await mkdtemp(join(tmpdir(), "next-coder-connector-pack-"));
try {
  const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: packageDir });
  const packed = JSON.parse(stdout);
  const tarball = join(scratch, packed[0].filename);
  const installDir = join(scratch, "install");
  await exec("npm", ["init", "--yes"], { cwd: scratch });
  await exec("npm", ["install", "--ignore-scripts", "--prefix", installDir, tarball], { cwd: scratch });
  const bin = join(installDir, "node_modules", ".bin", "next-coder-connect");
  const help = await exec(bin, ["--help"], { cwd: scratch });
  if (!help.stdout.includes("Next Coder connector")) throw new Error("Packed CLI help smoke failed.");
  const update = await exec(bin, ["update"], { cwd: scratch });
  if (!update.stdout.includes(expectedVersion)) throw new Error(`Packed CLI version smoke failed: expected ${expectedVersion}.`);
  const serviceHelp = await exec(bin, ["start", "--help"], { cwd: scratch });
  if (!serviceHelp.stdout.includes("per-user connector service")) throw new Error("Packed CLI service help smoke failed.");
  const files = packed[0].files.map((file) => file.path);
  if (files.some((file) => file.startsWith("test/") || file.startsWith("scripts/"))) throw new Error("Pack contains development-only files.");
  console.log(`Packed and clean-installed ${packed[0].filename} (${files.length} files).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
