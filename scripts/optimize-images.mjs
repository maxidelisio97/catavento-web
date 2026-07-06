import sharp from "sharp";
import { readdir, stat, unlink, rename } from "node:fs/promises";
import path from "node:path";

// En Windows, un antivirus o indexador puede tener el archivo recien escrito
// abierto por una fraccion de segundo. Reintentamos el rename en vez de fallar.
async function renameWithRetry(from, to, attempts = 5, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (err.code !== "EPERM" || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const ROOT = path.resolve("public/images");
const SKIP_DIRS = new Set(["responsive"]);
const SKIP_FILES = new Set(["og-image.jpg"]);
const CONVERTIBLE_EXT = new Set([".webp", ".jpg", ".jpeg", ".png"]);
const MAX_WIDTH = 1920;
const QUALITY = 74;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walk(full)));
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    if (!CONVERTIBLE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(full);
  }
  return files;
}

async function optimize(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const before = (await stat(filePath)).size;

  if (ext === ".webp") {
    const tmp = filePath + ".tmp";
    await sharp(filePath)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(tmp);
    await renameWithRetry(tmp, filePath);
    const after = (await stat(filePath)).size;
    return { from: filePath, to: filePath, before, after };
  }

  // jpg/jpeg/png -> webp, para unificar el pipeline en un solo formato
  const target = filePath.slice(0, -ext.length) + ".webp";
  await sharp(filePath)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(target);
  await unlink(filePath);
  const after = (await stat(target)).size;
  return { from: filePath, to: target, before, after };
}

async function run() {
  const files = await walk(ROOT);
  let totalBefore = 0;
  let totalAfter = 0;
  const failed = [];

  for (const file of files) {
    try {
      const result = await optimize(file);
      totalBefore += result.before;
      totalAfter += result.after;
      const label = path.relative(ROOT, result.from) === path.relative(ROOT, result.to)
        ? path.relative(ROOT, result.to)
        : `${path.relative(ROOT, result.from)} -> ${path.relative(ROOT, result.to)}`;
      console.log(
        `${label}: ${(result.before / 1024).toFixed(0)}KB -> ${(result.after / 1024).toFixed(0)}KB`
      );
    } catch (err) {
      // Un archivo bloqueado (abierto en otro programa) no debe frenar el resto del lote.
      failed.push(path.relative(ROOT, file));
      console.warn(`SKIP (bloqueado o con error): ${path.relative(ROOT, file)} — ${err.code || err.message}`);
    }
  }

  console.log(
    `\nTotal: ${(totalBefore / 1024 / 1024).toFixed(2)}MB -> ${(totalAfter / 1024 / 1024).toFixed(2)}MB`
  );
  if (failed.length) {
    console.log(`\n${failed.length} archivo(s) no se pudieron procesar (probablemente abiertos en otro programa):`);
    failed.forEach((f) => console.log(`  - ${f}`));
    console.log("Cerralos y corré `npm run images:optimize` de nuevo para completarlos.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
