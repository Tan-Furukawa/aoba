import { cp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const contentDir = path.join(root, "content");
const previewDir = path.join(root, "content_preview");
const jpegExtensions = new Set([".jpg", ".jpeg"]);

const options = parseArgs(process.argv.slice(2));
const targetDir = options.preview && !options.dryRun ? previewDir : contentDir;

function parseArgs(args) {
  const parsed = {
    preview: false,
    jpegQuality: 90,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--preview") {
      parsed.preview = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--jpeg-quality") {
      parsed.jpegQuality = parseInteger(requiredValue(args, (index += 1), arg), arg);
    } else if (arg.startsWith("--jpeg-quality=")) {
      parsed.jpegQuality = parseInteger(arg.slice("--jpeg-quality=".length), "--jpeg-quality");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (parsed.jpegQuality < 1 || parsed.jpegQuality > 100) {
    console.error("--jpeg-quality must be between 1 and 100.");
    process.exit(1);
  }

  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${option}.`);
    process.exit(1);
  }
  return value;
}

function parseInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    console.error(`Invalid integer for ${option}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/resize-content-images.mjs [options]

Options:
  --preview              Write results to content_preview instead of overwriting content
  --jpeg-quality <1-100> Re-encode JPEG images at this quality (default: 90)
  --dry-run              Print what would be changed without writing files

Examples:
  npm run content:resize-images
  npm run content:resize-images -- --jpeg-quality 85
  npm run content:resize-images:preview -- --jpeg-quality 90`);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkJpegs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJpegs(entryPath)));
    } else if (entry.isFile() && jpegExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function formatSize(bytes) {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(2)}MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)}KB`;
  return `${bytes}B`;
}

async function compressJpeg(filePath) {
  const buffer = await sharp(filePath, { failOn: "none" })
    .rotate()
    .withMetadata()
    .jpeg({ quality: options.jpegQuality, mozjpeg: true })
    .toBuffer();

  return {
    buffer,
    bytes: buffer.length,
  };
}

async function prepareTarget() {
  if (!options.preview) return;
  if (options.dryRun) return;

  await rm(previewDir, { recursive: true, force: true });
  await cp(contentDir, previewDir, { recursive: true });
}

async function main() {
  if (!(await pathExists(contentDir))) {
    console.error(`Missing content directory: ${contentDir}`);
    process.exit(1);
  }

  await prepareTarget();

  const images = await walkJpegs(targetDir);
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const imagePath of images) {
    const current = await stat(imagePath);
    const relativePath = path.relative(root, imagePath);

    try {
      const result = await compressJpeg(imagePath);
      const details = `${formatSize(current.size)} -> ${formatSize(result.bytes)}, quality=${options.jpegQuality}`;

      if (result.bytes >= current.size) {
        skipped += 1;
        console.log(`skip  ${relativePath} (${details})`);
        continue;
      }

      if (!options.dryRun) {
        const temporaryPath = path.join(path.dirname(imagePath), `.${path.basename(imagePath)}.compressing`);
        await writeFile(temporaryPath, result.buffer);
        await rename(temporaryPath, imagePath);
      }

      changed += 1;
      console.log(`${options.dryRun ? "would " : "compress"} ${relativePath} (${details})`);
    } catch (error) {
      failed += 1;
      console.log(`fail  ${relativePath} (${error.message})`);
    }
  }

  console.log("");
  console.log(
    `images=${images.length} changed=${changed} skipped=${skipped} failed=${failed} target=${path.relative(root, targetDir)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
