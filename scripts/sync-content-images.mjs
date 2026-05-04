import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const contentDir = path.join(root, "content");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!["prune", "add-src"].includes(mode)) {
  console.error("Usage: node scripts/sync-content-images.mjs <prune|add-src> [--dry-run]");
  process.exit(1);
}

async function pathExists(filePath) {
  try {
    await readdir(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = [dir];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirs.push(...(await walkDirs(path.join(dir, entry.name))));
  }

  return dirs;
}

async function getBundleMarkdown(dir) {
  for (const name of ["index.md", "_index.md"]) {
    const filePath = path.join(dir, name);
    try {
      await readFile(filePath, "utf8");
      return filePath;
    } catch {
      // Try the next conventional Hugo bundle file name.
    }
  }

  return null;
}

function splitFrontMatter(markdown) {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return null;

  return {
    frontMatter: markdown.slice(4, end),
    body: markdown.slice(end),
  };
}

function getResourceSrcs(frontMatter) {
  const srcs = new Set();
  const srcPattern = /^\s*-\s+src:\s*(.+?)\s*$/gm;
  let match;

  while ((match = srcPattern.exec(frontMatter))) {
    srcs.add(unquoteYamlScalar(match[1]));
  }

  return srcs;
}

function hasResourcesKey(frontMatter) {
  return /^resources:\s*$/m.test(frontMatter);
}

function getReferencedImageScalars(frontMatter) {
  const references = new Set();
  const imagePattern = new RegExp(
    String.raw`^\s*[A-Za-z0-9_-]+:\s*(.+?(${[...imageExtensions].map((ext) => ext.slice(1)).join("|")}))\s*$`,
    "gim",
  );
  let match;

  while ((match = imagePattern.exec(frontMatter))) {
    references.add(path.basename(unquoteYamlScalar(match[1])));
  }

  return references;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function getImageFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function addMissingSrcs(markdown, missing) {
  const parsed = splitFrontMatter(markdown);
  if (!parsed || missing.length === 0) return markdown;

  const lines = parsed.frontMatter.split("\n");
  const resourcesIndex = lines.findIndex((line) => /^resources:\s*$/.test(line));
  const additions = missing.map((name) => `  - src: ${name}`);

  if (resourcesIndex === -1) {
    const nextFrontMatter = [...lines, "resources:", ...additions].join("\n");
    return `---\n${nextFrontMatter}${parsed.body}`;
  }

  let insertIndex = resourcesIndex + 1;
  while (insertIndex < lines.length) {
    const line = lines[insertIndex];
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    insertIndex += 1;
  }

  const nextLines = [...lines.slice(0, insertIndex), ...additions, ...lines.slice(insertIndex)];
  return `---\n${nextLines.join("\n")}${parsed.body}`;
}

async function pruneImages(bundle) {
  const markdown = await readFile(bundle.markdownPath, "utf8");
  const parsed = splitFrontMatter(markdown);
  if (!parsed) return [];

  const srcs = getResourceSrcs(parsed.frontMatter);
  if (!hasResourcesKey(parsed.frontMatter)) return [];
  const protectedImages = getReferencedImageScalars(parsed.frontMatter);

  const imageFiles = await getImageFiles(bundle.dir);
  const removed = [];

  for (const image of imageFiles) {
    if (srcs.has(image) || protectedImages.has(image)) continue;

    const imagePath = path.join(bundle.dir, image);
    removed.push(path.relative(root, imagePath));
    if (!dryRun) await rm(imagePath);
  }

  return removed;
}

async function addSrcs(bundle) {
  const markdown = await readFile(bundle.markdownPath, "utf8");
  const parsed = splitFrontMatter(markdown);
  if (!parsed) return [];

  const srcs = getResourceSrcs(parsed.frontMatter);
  const imageFiles = await getImageFiles(bundle.dir);
  const missing = imageFiles.filter((image) => !srcs.has(image));

  if (missing.length === 0) return [];

  const nextMarkdown = addMissingSrcs(markdown, missing);
  if (!dryRun) await writeFile(bundle.markdownPath, nextMarkdown);

  return missing.map((image) => path.relative(root, path.join(bundle.dir, image)));
}

async function main() {
  if (!(await pathExists(contentDir))) {
    console.error(`Missing content directory: ${contentDir}`);
    process.exit(1);
  }

  const dirs = await walkDirs(contentDir);
  const bundles = [];

  for (const dir of dirs) {
    const markdownPath = await getBundleMarkdown(dir);
    if (markdownPath) bundles.push({ dir, markdownPath });
  }

  const changed = [];

  for (const bundle of bundles) {
    if (mode === "prune") {
      changed.push(...(await pruneImages(bundle)));
    } else {
      changed.push(...(await addSrcs(bundle)));
    }
  }

  const action = mode === "prune" ? "Removed" : "Added src for";
  if (changed.length === 0) {
    console.log("No changes.");
    return;
  }

  for (const file of changed) {
    console.log(`${dryRun ? "[dry-run] " : ""}${action}: ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
