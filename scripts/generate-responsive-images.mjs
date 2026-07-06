import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE = path.resolve("public/images/Entrada-parque.webp");
const OUT_DIR = path.resolve("public/images/responsive");
const WIDTHS = [640, 828, 1080, 1920];

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const width of WIDTHS) {
    const resized = sharp(SOURCE).resize({ width, withoutEnlargement: true });

    await resized
      .clone()
      .avif({ quality: 55 })
      .toFile(path.join(OUT_DIR, `hero-${width}.avif`));

    await resized
      .clone()
      .webp({ quality: 70 })
      .toFile(path.join(OUT_DIR, `hero-${width}.webp`));

    console.log(`hero-${width}.avif / .webp listos`);
  }

  // Open Graph / Twitter Card preview image.
  // JPG a proposito: los crawlers de link preview (WhatsApp incluido) no soportan
  // AVIF/WebP de forma confiable todavia.
  await sharp(SOURCE)
    .resize({ width: 1200, height: 630, fit: "cover" })
    .jpeg({ quality: 82 })
    .toFile(path.resolve("public/images/og-image.jpg"));
  console.log("og-image.jpg listo");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
