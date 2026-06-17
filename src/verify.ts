import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Subscription } from 'rxjs';
import type { RingCamera } from 'ring-client-api';
import { loadConfig } from './config.js';
import { createRingApi } from './ring.js';
import { recordClip } from './recorder.js';
import { log } from './log.js';

const execFileP = promisify(execFile);

/**
 * End-to-end verification harness. Run AFTER `npm run auth` has saved a token.
 *
 *   npm run verify -- [--camera "Name"] [--seconds 10] [--watch-motion 60]
 *
 * Runs the goal's verify checklist against the real account:
 *   1. authenticate + list real cameras
 *   2. capture a live clip to disk
 *   3. probe the clip for playable video (and report audio)
 *   4. (optional) wait for a real motion/ding event and confirm auto-recording
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seconds = args.seconds ? Number(args.seconds) : 10;
  const watchMotion = args['watch-motion'] ? Number(args['watch-motion']) : 0;
  const cfg = loadConfig();
  const api = createRingApi(cfg);

  let failures = 0;
  const step = (n: number, msg: string) => log.info(`[${n}] ${msg}`);

  try {
    // 1. AUTH + LIST ---------------------------------------------------------
    step(1, 'Authenticating and listing cameras…');
    const cameras = await api.getCameras();
    if (cameras.length === 0) throw new Error('Authenticated but found 0 cameras on the account.');
    for (const c of cameras) {
      const battery = c.batteryLevel != null ? `${c.batteryLevel}%` : 'wired';
      log.info(`    #${c.id}  ${c.name}  [${c.isDoorbot ? 'doorbell' : 'camera'}, ${c.model}, ${battery}]`);
    }
    log.info(`    ✓ Auth OK, ${cameras.length} camera(s) listed.`);

    const target = pickCamera(cameras, args.camera);
    if (!target) throw new Error(`No camera matched "${args.camera}".`);

    // 2. CAPTURE -------------------------------------------------------------
    step(2, `Capturing a ${seconds}s live clip from "${target.name}"…`);
    const clip = await recordClip(target, cfg, seconds);
    log.info(`    ✓ Wrote ${clip.path} (${(clip.bytes / 1024 / 1024).toFixed(2)} MB).`);

    // 3. PROBE ---------------------------------------------------------------
    step(3, 'Probing the clip for playable streams…');
    const streams = await probeStreams(clip.path);
    const hasVideo = streams.includes('video');
    const hasAudio = streams.includes('audio');
    if (!hasVideo) {
      failures++;
      log.error('    ✗ No video stream found — clip is not playable.');
    } else {
      log.info('    ✓ Video stream present, clip is playable.');
    }
    if (hasAudio) log.info('    ✓ Audio stream present.');
    else log.warn('    ! No audio stream (Ring audio can be off in the app, or omitted for this device).');

    // 4. MOTION TRIGGER (optional) ------------------------------------------
    if (watchMotion > 0) {
      step(4, `Waiting up to ${watchMotion}s for a real motion/ding on "${target.name}" — trigger it now (walk in front / press the doorbell)…`);
      const fired = await waitForTriggeredRecording(target, cfg, watchMotion);
      if (fired) log.info('    ✓ Motion/ding fired and an auto-recording completed end-to-end.');
      else {
        failures++;
        log.error(`    ✗ No motion/ding event within ${watchMotion}s. Re-run with a longer --watch-motion and trigger motion.`);
      }
    } else {
      step(4, 'Skipping motion test (pass --watch-motion <seconds> and trigger motion to verify it live).');
    }

    log.info(failures === 0 ? '\nVERIFY: all checks passed.' : `\nVERIFY: ${failures} check(s) failed.`);
  } finally {
    api.disconnect();
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 1500);
  }
}

/** Return the list of codec_types ("video"/"audio") present in a media file. */
async function probeStreams(file: string): Promise<string[]> {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
  return (parsed.streams ?? []).map((s) => s.codec_type ?? '').filter(Boolean);
}

/**
 * Subscribe to motion + ding for one camera; on the first event, record a short
 * clip and resolve true once it's on disk. Resolves false on timeout.
 */
function waitForTriggeredRecording(camera: RingCamera, cfg: ReturnType<typeof loadConfig>, timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    const subs: Subscription[] = [];
    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      subs.forEach((s) => s.unsubscribe());
      clearTimeout(timer);
      resolve(val);
    };
    const onTrigger = (reason: string) => {
      log.info(`    → ${reason} detected; recording a clip to prove the trigger path…`);
      recordClip(camera, cfg, Math.min(cfg.clipLengthSeconds, 10))
        .then(() => finish(true))
        .catch((e) => {
          log.error(`    recording after trigger failed: ${(e as Error).message}`);
          finish(false);
        });
    };
    subs.push(camera.onMotionDetected.subscribe((active: boolean) => active && onTrigger('motion')));
    if (camera.isDoorbot) subs.push(camera.onDoorbellPressed.subscribe(() => onTrigger('doorbell ding')));
    const timer = setTimeout(() => finish(false), timeoutSec * 1000);
  });
}

function pickCamera(cameras: RingCamera[], sel?: string): RingCamera | undefined {
  if (!sel) return cameras[0];
  const id = Number(sel);
  if (Number.isFinite(id)) {
    const hit = cameras.find((c) => c.id === id);
    if (hit) return hit;
  }
  return cameras.find((c) => c.name.toLowerCase().includes(sel.toLowerCase()));
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = 'true';
    }
  }
  return out;
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
