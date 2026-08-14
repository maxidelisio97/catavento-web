import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("public/images/responsive");

// Cada entrada genera AVIF+WebP en los anchos pedidos, nombrados
// `${name}-${width}.{avif,webp}` dentro de public/images/responsive/.
// Agregar una imagen nueva al flujo es agregar una entrada aca, nunca un
// <img> apuntando al archivo original (CLAUDE.md raiz).
const JOBS = [
  {
    name: "hero",
    source: "public/images/Entrada-parque.webp",
    widths: [640, 828, 1080, 1920],
  },
  {
    name: "reservar-dates",
    source: "public/images/dron.webp",
    widths: [480, 960],
  },
  {
    name: "room-casal",
    source: "public/images/Cuarto Casal/Cuarto-Casal6.webp",
    widths: [160, 320, 480],
  },
  {
    name: "room-triplo",
    source: "public/images/Cuarto triplo/Cuarto-triple2.webp",
    widths: [160, 320, 480],
  },
  {
    name: "room-triplo-exterior",
    source: "public/images/Cuarto triplo/cuarto-triplo-exterior.jpg",
    widths: [480, 900],
  },
  {
    name: "room-quadruplo",
    source: "public/images/Cuarto Cuadruplo/Cuarto-Cuadruple1.webp",
    widths: [160, 320, 480],
  },
];

async function generate({ name, source, widths }) {
  const sourcePath = path.resolve(source);

  for (const width of widths) {
    const resized = sharp(sourcePath).resize({ width, withoutEnlargement: true });

    await resized
      .clone()
      .avif({ quality: 55 })
      .toFile(path.join(OUT_DIR, `${name}-${width}.avif`));

    await resized
      .clone()
      .webp({ quality: 70 })
      .toFile(path.join(OUT_DIR, `${name}-${width}.webp`));

    console.log(`${name}-${width}.avif / .webp listos`);
  }
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const job of JOBS) {
    await generate(job);
  }

  // Open Graph / Twitter Card preview image (siempre desde el hero).
  // JPG a proposito: los crawlers de link preview (WhatsApp incluido) no soportan
  // AVIF/WebP de forma confiable todavia.
  await sharp(path.resolve("public/images/Entrada-parque.webp"))
    .resize({ width: 1200, height: 630, fit: "cover" })
    .jpeg({ quality: 82 })
    .toFile(path.resolve("public/images/og-image.jpg"));
  console.log("og-image.jpg listo");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
