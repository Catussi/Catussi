/**
 * Banner = solo escritorio catussi-os (wallpaper + iconos, sin ventanas).
 * Captura vía CDP screencast para acercarse a 60 fps reales.
 *
 *   cd catussi-os && npm run build && npx serve out -l 3010
 *   cd mi-perfil-github && npm run generate:desktop
 *
 * Env: BANNER_FPS=60 BANNER_SECONDS=1.5 PROFILE_URL=http://localhost:3010
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

const FPS = Number(process.env.BANNER_FPS) || 60;
const SECONDS = Number(process.env.BANNER_SECONDS) || 1.5;
const TARGET_FRAMES = Math.round(FPS * SECONDS);
const FRAME_DELAY_MS = 1000 / FPS;

const VIEWPORT_W = 1152;
const VIEWPORT_H = 360;
const BANNER_W = 1152;
const BANNER_H = 360;

const PALETTE_SIZE = 96;
const PALETTE_SAMPLE_FRAMES = 12;

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
  const delayMs = Math.max(1, Math.round(FRAME_DELAY_MS));

  frames.forEach((frame) => {
    const indexed = applyPalette(new Uint8Array(frame.data), palette);
    gif.writeFrame(indexed, frame.width, frame.height, {
      palette,
      delay: delayMs,
      dispose: 1,
    });
  });

  gif.finish();
  return Buffer.from(gif.bytes());
};

const pickEvenly = (buffers, count) => {
  if (buffers.length <= count) return buffers;

  const picked = [];
  const step = (buffers.length - 1) / (count - 1);

  for (let i = 0; i < count; i += 1) {
    picked.push(buffers[Math.round(i * step)]);
  }

  return picked;
};

const captureScreencast = async (page, durationMs) =>
  new Promise((resolve, reject) => {
    const buffers = [];
    let client;
    let timeoutId;

    const finish = async () => {
      clearTimeout(timeoutId);
      try {
        await client?.send("Page.stopScreencast");
      } catch {
        // already stopped
      }
      client?.removeAllListeners();
      resolve(buffers);
    };

    page
      .context()
      .newCDPSession(page)
      .then(async (cdp) => {
        client = cdp;

        client.on("Page.screencastFrame", async ({ data, sessionId }) => {
          buffers.push(Buffer.from(data, "base64"));
          try {
            await client.send("Page.screencastFrameAck", { sessionId });
          } catch {
            // ignore
          }
        });

        await client.send("Page.startScreencast", {
          format: "jpeg",
          quality: 85,
          maxWidth: VIEWPORT_W,
          maxHeight: VIEWPORT_H,
          everyNthFrame: 1,
        });

        timeoutId = setTimeout(() => {
          finish().catch(reject);
        }, durationMs);
      })
      .catch(reject);
  });

const main = async () => {
  const url = await resolveProfileUrl();
  console.log(
    `Capturando escritorio ~${FPS}fps · ${SECONDS}s (objetivo ${TARGET_FRAMES}f) → ${OUTPUT}`
  );

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

    const captureMs = Math.round(SECONDS * 1000);
    const start = performance.now();
    const rawBuffers = await captureScreencast(page, captureMs);
    const elapsed = (performance.now() - start) / 1000;
    const captureFps = rawBuffers.length / elapsed;

    const selected = pickEvenly(rawBuffers, TARGET_FRAMES);
    const frames = [];

    for (const buffer of selected) {
      frames.push(await processFrame(buffer));
    }

    const gif = encodeGif(frames);
    writeFileSync(OUTPUT, gif);

    console.log(
      `Listo: ${OUTPUT} (${frames.length}f @ ${FPS}fps playback, ${rawBuffers.length} capturados en ${elapsed.toFixed(2)}s ~${captureFps.toFixed(1)}fps, ${(gif.length / 1024 / 1024).toFixed(2)} MB)`
    );
  } finally {
    await browser.close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
