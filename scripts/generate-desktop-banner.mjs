/**
 * Banner = escritorio catussi-os (wallpaper + iconos, sin ventanas).
 * Captura CDP en alta calidad, detecta el mejor punto de bucle y aplica
 * crossfade para que el GIF parezca infinito sin salto visible.
 *
 *   cd catussi-os && npm run build && npx serve out -l 3010
 *   cd mi-perfil-github && npm run generate:desktop
 *
 * Env:
 *   BANNER_FPS=30          — fps de reproducción del GIF
 *   BANNER_CAPTURE_SECONDS=10 — ventana de captura para buscar el bucle
 *   BANNER_MIN_LOOP_SECONDS=3
 *   BANNER_CROSSFADE_RATIO=0.18
 *   BANNER_DPR=2
 *   BANNER_PALETTE=160
 *   PROFILE_URL=http://localhost:3010
 */

import { chromium } from "playwright";
import gifenc from "gifenc";
import { writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "profile.gif");

const PLAYBACK_FPS = Number(process.env.BANNER_FPS) || 30;
const CAPTURE_SECONDS = Number(process.env.BANNER_CAPTURE_SECONDS) || 12;
const MIN_LOOP_SECONDS = Number(process.env.BANNER_MIN_LOOP_SECONDS) || 2;
const MAX_LOOP_SECONDS = Number(process.env.BANNER_MAX_LOOP_SECONDS) || 4.5;
const CROSSFADE_RATIO = Number(process.env.BANNER_CROSSFADE_RATIO) || 0.35;
/** Periodos dominantes del shader Coastal (olas iTime*3, etc.) en segundos */
const HARMONIC_LOOP_SECONDS = [2.094, 4.188, 3.142, 6.283];
const DEVICE_SCALE = Number(process.env.BANNER_DPR) || 2;
const PALETTE_SIZE = Number(process.env.BANNER_PALETTE) || 144;
const JPEG_QUALITY = Number(process.env.BANNER_JPEG_QUALITY) || 92;

const CAPTURE_FPS = Number(process.env.BANNER_CAPTURE_FPS) || 40;

const VIEWPORT_W = 1152;
const VIEWPORT_H = 360;
const BANNER_W = 1152;
const BANNER_H = 360;

const THUMB_W = 128;
const THUMB_H = 40;
const PALETTE_SAMPLE_FRAMES = 16;

const DESKTOP_SELECTOR = "body>#__next>main";
const WALLPAPER_CANVAS = `${DESKTOP_SELECTOR}>canvas`;
const DESKTOP_ENTRIES = `${DESKTOP_SELECTOR}>ol>li`;

const sleep = (ms) => new Promise((r) => setTimeout((r) => ms));

const resolveProfileUrl = async () => {
  if (process.env.PROFILE_URL) return process.env.PROFILE_URL;

  for (const port of [3010, 3001, 3000]) {
    try {
      const r = await fetch(`http://localhost:${port}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return `http://localhost:${port}`;
    } catch {
      // next
    }
  }

  throw new Error("Levanta catussi-os: npm run build && npx serve out -l 3010");
};

const processFrame = async (buffer) => {
  const pipeline = sharp(buffer).resize(BANNER_W, BANNER_H, {
    fit: "fill",
    kernel: sharp.kernel.lanczos3,
  });

  const { data, info } = await pipeline
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const signature = await pipeline
    .clone()
    .resize(THUMB_W, THUMB_H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  return { data, width: info.width, height: info.height, signature };
};

const signatureDistance = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 2) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / (a.length / 2));
};

const loopScoreAt = (signatures, start, len) => {
  const end = start + len;
  if (end >= signatures.length) return Number.POSITIVE_INFINITY;

  let score = signatureDistance(signatures[start], signatures[end]);
  let weight = 1;

  const checkpoints = [
    Math.floor(len * 0.25),
    Math.floor(len * 0.5),
    Math.floor(len * 0.75),
  ];

  for (const offset of checkpoints) {
    if (offset > 0 && start + offset + len < signatures.length) {
      score += signatureDistance(
        signatures[start + offset],
        signatures[start + offset + len]
      );
      weight += 1;
    }
  }

  // El último frame del ciclo debe fundirse con el primero
  if (len > 1) {
    score += signatureDistance(signatures[start + len - 1], signatures[start]) * 1.5;
    weight += 1.5;
  }

  score /= weight;

  const loopSeconds = len / PLAYBACK_FPS;
  let harmonicPenalty = 1;
  for (const period of HARMONIC_LOOP_SECONDS) {
    const delta = Math.abs(loopSeconds - period);
    if (delta < 0.12) {
      harmonicPenalty = 0.55;
      break;
    }
    if (delta < 0.25) {
      harmonicPenalty = Math.min(harmonicPenalty, 0.75);
    }
  }
  score *= harmonicPenalty;

  return score;
};

const findBestLoop = (signatures) => {
  const minLen = Math.max(12, Math.round(MIN_LOOP_SECONDS * PLAYBACK_FPS));
  let maxLen = Math.min(
    signatures.length - 1,
    Math.round(MAX_LOOP_SECONDS * PLAYBACK_FPS)
  );
  if (maxLen < minLen) maxLen = minLen;

  const maxStart = Math.min(
    Math.round(PLAYBACK_FPS * 1.5),
    Math.max(0, signatures.length - minLen - 2)
  );

  let best = { start: 0, length: minLen, score: Number.POSITIVE_INFINITY };

  for (let start = 0; start <= maxStart; start += 1) {
    for (let len = minLen; len <= maxLen; len += 1) {
      const score = loopScoreAt(signatures, start, len);
      if (score < best.score) {
        best = { start, length: len, score };
      }
    }
  }

  return best;
};

const pickEvenly = (items, count) => {
  if (items.length <= count) return items;

  const picked = [];
  const step = (items.length - 1) / (count - 1);

  for (let i = 0; i < count; i += 1) {
    picked.push(items[Math.round(i * step)]);
  }

  return picked;
};

const cloneFrame = (frame) => ({
  data: new Uint8Array(frame.data),
  width: frame.width,
  height: frame.height,
});

const blendFrames = (frameA, frameB, t) => {
  const a = frameA.data;
  const b = frameB.data;
  const out = new Uint8Array(a.length);
  const inv = 1 - t;

  for (let i = 0; i < a.length; i += 1) {
    out[i] = Math.round(a[i] * inv + b[i] * t);
  }

  return { data: out, width: frameA.width, height: frameA.height };
};

const smoothstep = (t) => t * t * (3 - 2 * t);

const applySeamlessCrossfade = (frames, fadeFrames) => {
  if (fadeFrames < 2 || frames.length <= fadeFrames) return frames;

  const result = frames.map(cloneFrame);
  const n = result.length;

  for (let i = 0; i < fadeFrames; i += 1) {
    const t = smoothstep((i + 1) / fadeFrames);
    const tailIdx = n - fadeFrames + i;
    result[tailIdx] = blendFrames(result[tailIdx], result[i], t);
  }

  // Cierre exacto: último frame = primero (el GIF vuelve al frame 0 sin salto)
  result[n - 1] = cloneFrame(result[0]);

  return result;
};

const sealLoop = (frames) => {
  if (frames.length < 2) return frames;
  const sealed = frames.map(cloneFrame);
  sealed[sealed.length - 1] = cloneFrame(sealed[0]);
  return sealed;
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
  const delayMs = Math.max(1, Math.round(1000 / PLAYBACK_FPS));

  frames.forEach((frame, index) => {
    const indexed = applyPalette(new Uint8Array(frame.data), palette);
    gif.writeFrame(indexed, frame.width, frame.height, {
      palette,
      delay: delayMs,
      dispose: 1,
      ...(index === 0 ? { repeat: 0 } : {}),
    });
  });

  gif.finish();
  return Buffer.from(gif.bytes());
};

const DEBUG = process.env.BANNER_DEBUG === "1";
const DEBUG_LOG = resolve(__dirname, "..", ".banner-debug.log");

const trace = (step) => {
  if (!DEBUG) return;
  appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${step}\n`);
};

const log = (...args) => {
  console.log(...args);
  trace(args.join(" "));
};

const captureScreencast = async (page, durationMs) =>
  new Promise((resolve, reject) => {
    const buffers = [];
    let client;
    let timeoutId;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      client?.removeAllListeners();
      client
        ?.send("Page.stopScreencast")
        .catch(() => {})
        .finally(() => resolve(buffers));
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
          quality: JPEG_QUALITY,
          maxWidth: VIEWPORT_W * DEVICE_SCALE,
          maxHeight: VIEWPORT_H * DEVICE_SCALE,
          everyNthFrame: 1,
        });

        timeoutId = setTimeout(finish, durationMs);
      })
      .catch(reject);
  });

const main = async () => {
  if (DEBUG) writeFileSync(DEBUG_LOG, "");
  trace("start");
  const url = await resolveProfileUrl();
  const targetCaptureFrames = Math.round(CAPTURE_SECONDS * PLAYBACK_FPS);

  console.log(
    `Capturando escritorio · ${CAPTURE_SECONDS}s · bucle infinito · DPR ${DEVICE_SCALE} → ${OUTPUT}`
  );

    trace("browser.launch");
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
    const context = await browser.newContext({
      deviceScaleFactor: DEVICE_SCALE,
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    });
    const page = await context.newPage();
    trace("page.goto");
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.waitForSelector(WALLPAPER_CANVAS, { timeout: 120_000 });
    await page.waitForSelector(DESKTOP_ENTRIES, { timeout: 60_000 });
    trace("desktop.ready");
    console.log("  Escritorio listo, calentando wallpaper…");
    await page.waitForTimeout(4000);
    trace("warmup.done");

    log(`  Capturando screencast ${CAPTURE_SECONDS}s…`);
    const captureMs = Math.round(CAPTURE_SECONDS * 1000);
    const start = performance.now();
    const rawBuffers = await captureScreencast(page, captureMs);
    trace("capture.done");
    const elapsed = (performance.now() - start) / 1000;
    const captureFps = rawBuffers.length / elapsed;

    log(
      `  ${rawBuffers.length} frames crudos en ${elapsed.toFixed(2)}s (~${captureFps.toFixed(1)} fps)`
    );

    const sampledBuffers = pickEvenly(rawBuffers, targetCaptureFrames);
    log(`  Procesando ${sampledBuffers.length} frames…`);
    const allFrames = [];

    for (let i = 0; i < sampledBuffers.length; i += 1) {
      allFrames.push(await processFrame(sampledBuffers[i]));
      if ((i + 1) % 30 === 0 && DEBUG) {
        log(`    ${i + 1}/${sampledBuffers.length}`);
      }
    }

    const signatures = allFrames.map((frame) => frame.signature);

    const {
      start: loopStart,
      length: loopLength,
      score: loopScore,
    } = findBestLoop(signatures);
    let loopFrames = allFrames
      .slice(loopStart, loopStart + loopLength)
      .map(cloneFrame);

    const fadeFrames = Math.max(
      18,
      Math.min(
        Math.round(loopLength * CROSSFADE_RATIO),
        Math.floor(loopLength / 2)
      )
    );

    log(
      `  Bucle: offset ${loopStart}f · ${loopLength}f (score ${loopScore.toFixed(2)}), crossfade ${fadeFrames}f`
    );
    loopFrames = applySeamlessCrossfade(loopFrames, fadeFrames);
    loopFrames = sealLoop(loopFrames);

    trace("encode.start");
    const gif = encodeGif(loopFrames);
    trace("encode.done");
    writeFileSync(OUTPUT, gif);

    const loopSeconds = (loopLength / PLAYBACK_FPS).toFixed(2);
    console.log(
      `Listo: ${OUTPUT}\n` +
        `  ${loopFrames.length}f @ ${PLAYBACK_FPS}fps (${loopSeconds}s por ciclo)\n` +
        `  paleta ${PALETTE_SIZE} · ${(gif.length / 1024 / 1024).toFixed(2)} MB`
    );
  } finally {
    await browser.close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
