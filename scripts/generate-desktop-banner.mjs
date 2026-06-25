/**
 * Banner = solo escritorio catussi-os (wallpaper animado + iconos, sin ventanas).
 * Clic en el README → catussi.dev
 *
 *   cd catussi-os && npm run build && npx serve out -l 3010
 *   cd mi-perfil-github && npm run generate:desktop
 */

import { chromium } from "playwright";
import gifenc from "gifenc";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "profile.gif");

const VIEWPORT_W = 1280;
const VIEWPORT_H = 400;
const BANNER_W = 1280;
const BANNER_H = 400;

const FPS = 18;
const FRAME_DELAY_MS = Math.round(1000 / FPS);
const SECONDS = 2.4;
const FRAMES = Math.round(FPS * SECONDS);
const PALETTE_SIZE = 80;
const PALETTE_SAMPLE_FRAMES = 10;

const DESKTOP_SELECTOR = "body>#__next>main";
const WALLPAPER_CANVAS = `${DESKTOP_SELECTOR}>canvas`;
const DESKTOP_ENTRIES = `${DESKTOP_SELECTOR}>ol>li`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resolveProfileUrl = async () => {
  if (process.env.PROFILE_URL) return process.env.PROFILE_URL;

  for (const port of [3010, 3001, 3000]) {
    try {
      const r = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return `http://localhost:${port}`;
    } catch {
      // next
    }
  }

  throw new Error("Levanta catussi-os: npm run build && npx serve out -l 3010");
};

const processFrame = async (buffer) => {
  const { data, info } = await sharp(buffer)
    .resize(BANNER_W, BANNER_H, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
};

const buildPalette = (frames) => {
  const step = Math.max(1, Math.floor(frames.length / PALETTE_SAMPLE_FRAMES));
  const sample = new Uint8Array(frames[0].data.length * PALETTE_SAMPLE_FRAMES);
  let offset = 0;

  for (let i = 0; i < frames.length && offset < sample.length; i += step) {
    sample.set(new Uint8Array(frames[i].data), offset);
    offset += frames[i].data.length;
  }

  return quantize(sample.subarray(0, offset), PALETTE_SIZE);
};

const encodeGif = (frames) => {
  const gif = GIFEncoder();
  const palette = buildPalette(frames);

  frames.forEach((frame) => {
    const indexed = applyPalette(new Uint8Array(frame.data), palette);
    gif.writeFrame(indexed, frame.width, frame.height, {
      palette,
      delay: FRAME_DELAY_MS,
      dispose: 1,
    });
  });

  gif.finish();
  return Buffer.from(gif.bytes());
};

const waitForNextFrame = async (frameIndex, start) => {
  const target = start + (frameIndex + 1) * FRAME_DELAY_MS;
  const wait = target - Date.now();

  if (wait > 0) await sleep(wait);
};

const main = async () => {
  const url = await resolveProfileUrl();
  console.log(`Capturando escritorio (sin ventanas) → ${OUTPUT}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-gpu",
      "--use-gl=angle",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: VIEWPORT_W, height: VIEWPORT_H });
    await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForSelector(WALLPAPER_CANVAS, { timeout: 120_000 });
    await page.waitForSelector(DESKTOP_ENTRIES, { timeout: 60_000 });
    await sleep(5000);

    const desktop = page.locator(DESKTOP_SELECTOR);
    const frames = [];
    const start = Date.now();

    for (let i = 0; i < FRAMES; i += 1) {
      frames.push(await processFrame(await desktop.screenshot({ type: "png" })));
      await waitForNextFrame(i, start);
    }

    const gif = encodeGif(frames);
    writeFileSync(OUTPUT, gif);
    console.log(
      `Listo: ${OUTPUT} (${FRAMES}f @ ${FPS}fps, ${(gif.length / 1024 / 1024).toFixed(2)} MB)`
    );
  } finally {
    await browser.close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
