import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/*
 * NOTHING HERE STARTS A PROGRAM BY ITS BARE NAME.
 *
 * On Windows, npm, npx and every tool in node_modules/.bin are .cmd files,
 * which only a shell can start. A spawn that names one fails there with
 * ENOENT while passing on Linux and macOS, and this package is published
 * from Windows, so such a test blocks every release. Start Node itself
 * (process.execPath) and give it the tool's JavaScript entry instead.
 *
 * exec and execSync are not flagged: they run through a shell, which finds
 * .cmd files.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const SPAWN = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["'`]/;
const COMMAND = /\bcommand\s*:\s*["'`]/;

function sources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]s)$/.test(name) ? [path] : [];
  });
}

it("starts every program through Node, never by a bare name", () => {
  const offenders: string[] = [];
  for (const file of ["src", "tests", "scripts"].flatMap((dir) => sources(join(root, dir)))) {
    if (file === self) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        if (SPAWN.test(code) || COMMAND.test(code)) offenders.push(`${relative(root, file)}:${index + 1}  ${code}`);
      });
  }
  expect(offenders, "Start programs with process.execPath and a JavaScript entry: .cmd files need a shell on Windows").toEqual([]);
});
