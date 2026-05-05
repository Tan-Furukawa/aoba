import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const contentDir = path.join(root, "content");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const dryRun = process.argv.includes("--dry-run");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/delete-content-images.mjs [--dry-run]

Deletes all image files under content/.

Options:
  --dry-run  Print files that would be deleted without deleting them`);
  process.exit(0);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkImages(entryPath)));
    } else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function main() {
  if (!(await pathExists(contentDir))) {
    console.error(`Missing content directory: ${contentDir}`);
    process.exit(1);
  }

  const images = await walkImages(contentDir);

  for (const image of images) {
    const relativePath = path.relative(root, image);
    console.log(`${dryRun ? "would delete" : "delete"} ${relativePath}`);
    if (!dryRun) await rm(image);
  }

  console.log("");
  console.log(`images=${images.length} deleted=${dryRun ? 0 : images.length} dryRun=${dryRun}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
