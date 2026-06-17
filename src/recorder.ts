import { join } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { firstValueFrom } from 'rxjs';
import type { RingCamera } from 'ring-client-api';
import type { AppConfig } from './config.js';
import { clipFilename, ensureDir } from './files.js';
import { log } from './log.js';

/**
 * ffmpeg output args for a single timestamped clip.
 *
 * `+frag_keyframe+empty_moov+default_base_moof` makes a *fragmented* MP4: the
 * header is written up front and self-contained fragments are flushed as the
 * stream arrives. If the process is killed mid-recording (Ctrl-C on the service,
 * a crash, a dropped stream), the file remains playable up to the last whole
 * fragment — instead of the "moov atom not found" corruption you get from a
 * plain MP4 that only writes its index at the very end.
 */
function clipOutputArgs(seconds: number, outPath: string): string[] {
  return [
    '-t', String(seconds),
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    outPath,
  ];
}

export interface RecordResult {
  camera: string;
  path: string;
  bytes: number;
  seconds: number;
}

/**
 * Record a single live clip from `camera` for `seconds` to the output dir.
 *
 * Uses the library's `recordToFile`, which opens a WebRTC live call, transcodes
 * via ffmpeg, and resolves when the duration elapses (`-t <seconds>`). Throws if
 * the live call never starts (camera offline / throttled / auth lapsed).
 */
export async function recordClip(
  camera: RingCamera,
  cfg: AppConfig,
  seconds: number,
): Promise<RecordResult> {
  ensureDir(cfg.outputDir);
  const startedAt = new Date();
  const filename = clipFilename(camera.name, startedAt);
  const outPath = join(cfg.outputDir, filename);

  log.info(`Recording ${seconds}s from "${camera.name}" → ${filename}`);

  // Open a live WebRTC call and transcode to a fragmented MP4 (see clipOutputArgs).
  // The call resolves via onCallEnded when ffmpeg exits (duration reached). A hung
  // call would otherwise hang forever, so cap the wait with a generous margin.
  const startTimeoutMs = 30_000;
  const hardTimeoutMs = (seconds + 30) * 1000;
  // Cap the call setup too: streamVideo() performs WebRTC signaling that can hang
  // on flaky networks or the unofficial API, and the onCallEnded timeout below
  // only starts counting once the session object exists.
  const session = await withTimeout(
    camera.streamVideo({ output: clipOutputArgs(seconds, outPath) }),
    startTimeoutMs,
    `live stream for "${camera.name}" did not start within ${startTimeoutMs / 1000}s`,
  );
  try {
    await withTimeout(
      firstValueFrom(session.onCallEnded),
      hardTimeoutMs,
      `live call for "${camera.name}" exceeded ${hardTimeoutMs / 1000}s`,
    );
  } catch (err) {
    session.stop(); // ensure the WebRTC session + ffmpeg are torn down on timeout
    throw err;
  }

  let bytes = 0;
  try {
    bytes = statSync(outPath).size;
  } catch {
    throw new Error(`Recording finished but no file was written at ${outPath}`);
  }
  if (bytes === 0) {
    // A 0-byte file means the live stream never produced data — clean it up so it
    // doesn't masquerade as a real clip (and survive a retention sweep).
    rmSync(outPath, { force: true });
    throw new Error(`Recording produced an empty file (stream never started) for "${camera.name}"`);
  }

  log.info(`Saved ${filename} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  return { camera: camera.name, path: outPath, bytes, seconds };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
