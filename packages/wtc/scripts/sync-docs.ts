// prepack step: copy docs/authoring-setup.md into packages/wtc/docs/ (gitignored, shipped via package.json "files").
// Repo-relative links (`../kit/...`, `../examples/...`) don't exist inside the tarball, so they become GitHub URLs pinned to the package version's tag.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const { version } = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
const base = `https://github.com/lyonbot/wtc/blob/v${version}/`;

const src = await readFile(join(root, "docs", "authoring-setup.md"), "utf8");
const out = src.replace(/\]\(\.\.\/([^)]+)\)/g, (_, p) => `](${base}${p})`);

await mkdir(join(import.meta.dir, "..", "docs"), { recursive: true });
await writeFile(join(import.meta.dir, "..", "docs", "authoring-setup.md"), out);
