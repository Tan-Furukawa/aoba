import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const contentDir = path.join(root, "content");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const remote = !args.includes("--local");
const bucket = getArgValue("--bucket") ?? process.env.R2_BUCKET ?? "aoba-assets";

function getArgValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }

  return files;
}

function isImage(filePath) {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

function objectKey(filePath) {
  return path.relative(contentDir, filePath).split(path.sep).join("/");
}

async function main() {
  const images = (await walkFiles(contentDir)).filter(isImage).sort((a, b) => a.localeCompare(b));

  if (images.length === 0) {
    console.log("No content images found.");
    return;
  }

  for (const image of images) {
    const key = objectKey(image);
    const target = `${bucket}/${key}`;
    const command = [
      "wrangler",
      "r2",
      "object",
      "put",
      target,
      "--file",
      image,
      "--content-type",
      contentType(image),
    ];

    if (remote) command.push("--remote");

    if (dryRun) {
      console.log(`[dry-run] npx ${command.join(" ")}`);
      continue;
    }

    console.log(`Uploading ${path.relative(root, image)} -> r2://${target}`);
    const result = spawnSync("npx", command, { stdio: "inherit" });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
