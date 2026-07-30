import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Subscription } from 'rxjs';
import type { PushNotificationDingV2, RingCamera } from 'ring-client-api';
import type { AppConfig } from './config.js';
import { recordClip, type RecordResult } from './recorder.js';
import { appendJsonLine } from './files.js';
import {
  buildTimingRecord,
  detectionSnapshotPath,
  parseNotification,
  pickDetection,
  type DetectionContext,
} from './detection.js';
import { log } from './log.js';

/** Recorder function shape — injectable so the trigger logic is unit-testable. */
export type RecordFn = (camera: RingCamera, cfg: AppConfig, seconds: number) => Promise<RecordResult>;

/** Snapshot fetcher — injectable for the same reason. */
export type SnapshotFn = (camera: RingCamera, uuid: string) => Promise<Buffer>;

/**
 * A notification older than this is treated as unrelated to the trigger firing
 * now. Generous enough to absorb event-loop and push-processing jitter, far
 * short of the `motionCooldownSeconds` floor between clips.
 */
const DETECTION_MAX_AGE_MS = 15_000;

/** Per-camera runtime state used to debounce overlapping triggers. */
interface CameraState {
  recording: boolean;
  lastStartMs: number;
  motionActive: boolean;
  /** Most recent push notification seen for this camera, for latency accounting. */
  lastDetection?: DetectionContext;
}

/**
 * Decide whether an incoming motion/ding event should start a new recording.
 *
 * This is the core triggering policy. The default below:
 *   - skips if a recording for this camera is already in progress, and
 *   - enforces `motionCooldownSeconds` between the START of consecutive clips.
 *
 * Trade-offs you may want to change (see README "Triggering policy"):
 *   - "extend" instead of "skip": keep recording while motion persists (better
 *     coverage of long events, but unbounded clip length + battery drain).
 *   - shorter/zero cooldown: more clips, more overlap, more account API load.
 */
const defaultSnapshotFn: SnapshotFn = (camera, uuid) => camera.getSnapshotByUuid(uuid);

/**
 * Fetch the detection-time snapshot, or resolve null.
 *
 * Never rejects. `img.snapshot_uuid` is optional in Ring's payload and the
 * fetch itself can fail (expired uuid, throttling, no subscription), none of
 * which is a reason to fail the clip that is already recording.
 */
async function fetchDetectionSnapshot(
  camera: RingCamera,
  cfg: AppConfig,
  detection: DetectionContext | undefined,
  snapshotFn: SnapshotFn,
): Promise<Buffer | null> {
  if (!cfg.detectionSnapshots) return null;
  const uuid = detection?.snapshotUuid;
  if (!uuid) {
    log.debug(`No detection snapshot uuid in the push for "${camera.name}".`);
    return null;
  }
  try {
    return await snapshotFn(camera, uuid);
  } catch (err) {
    log.warn(`Could not fetch detection snapshot for "${camera.name}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Write the detection snapshot next to the clip and append the latency record.
 * Never throws — see appendJsonLine for the same reasoning.
 */
async function writeCaptureMetadata(
  cfg: AppConfig,
  result: RecordResult,
  detection: DetectionContext | undefined,
  snapshot: Buffer | null,
  triggerAtMs: number,
): Promise<void> {
  let snapshotFile: string | null = null;
  if (snapshot) {
    const path = detectionSnapshotPath(result.path);
    try {
      writeFileSync(path, snapshot);
      snapshotFile = path.split('/').pop() ?? null;
      log.info(`Saved detection snapshot ${snapshotFile} (${(snapshot.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      log.warn(`Could not write detection snapshot: ${(err as Error).message}`);
    }
  }

  if (!cfg.timingLog) return;
  const record = buildTimingRecord({
    cameraName: result.camera,
    clipFile: result.path.split('/').pop() ?? result.path,
    snapshotFile,
    detection,
    timing: result.timing ?? { triggerAtMs },
  });
  appendJsonLine(join(cfg.outputDir, 'timing.jsonl'), record);
  if (record.blindWindowSec !== null) {
    log.info(
      `Latency: Ring detection -> first frame ${record.blindWindowSec}s ` +
        `(push ${record.pushDelaySec}s, stream setup ${record.streamSetupSec}s, first frame ${record.firstFrameSec}s)`,
    );
  }
}

function shouldTrigger(state: CameraState, cfg: AppConfig, nowMs: number): boolean {
  if (state.recording) return false;
  const sinceLastMs = nowMs - state.lastStartMs;
  if (sinceLastMs < cfg.motionCooldownSeconds * 1000) return false;
  return true;
}

/**
 * Wire motion + ding subscriptions for one camera. Returns the RxJS
 * subscriptions so the caller can tear them down on shutdown.
 */
export function watchCamera(
  camera: RingCamera,
  cfg: AppConfig,
  recordFn: RecordFn = recordClip,
  snapshotFn: SnapshotFn = defaultSnapshotFn,
): Subscription[] {
  const state: CameraState = { recording: false, lastStartMs: 0, motionActive: false };
  const subs: Subscription[] = [];

  // Capture the raw push so we get Ring's own detection timestamp and the
  // detection-time snapshot uuid. onMotionDetected only carries a boolean, and
  // the boolean is what triggers — so this runs as a parallel stream whose
  // absence must never stop a recording.
  if (typeof camera.onNewNotification?.subscribe === 'function') {
    subs.push(
      camera.onNewNotification.subscribe((n: PushNotificationDingV2) => {
        state.lastDetection = parseNotification(n, Date.now());
      }),
    );
  }

  const trigger = (reason: string) => {
    const now = Date.now();
    if (!shouldTrigger(state, cfg, now)) {
      log.debug(`Ignoring ${reason} on "${camera.name}" (busy or within cooldown).`);
      return;
    }
    state.recording = true;
    state.lastStartMs = now;
    log.info(`Trigger: ${reason} on "${camera.name}".`);

    const detection = pickDetection(state.lastDetection, now, DETECTION_MAX_AGE_MS);
    // Fetch the detection snapshot in parallel with the recording, not after:
    // it is the earliest view of the event and Ring expires these, so waiting
    // out a 30s clip first risks losing the one frame showing the approach.
    const snapshot = fetchDetectionSnapshot(camera, cfg, detection, snapshotFn);

    // Wrap in Promise.resolve().then(...) so a *synchronous* throw in recordFn
    // still becomes a rejection (caught below) and can never leave state.recording
    // stuck at true, which would permanently block this camera.
    Promise.resolve()
      .then(() => recordFn(camera, cfg, cfg.clipLengthSeconds))
      .then(async (result) => {
        await writeCaptureMetadata(cfg, result, detection, await snapshot, now);
      })
      .catch((err) => log.error(`Recording failed for "${camera.name}": ${(err as Error).message}`))
      .finally(() => {
        state.recording = false;
      });
  };

  if (cfg.recordOnMotion) {
    subs.push(
      // onMotionDetected emits a boolean. Trigger only on the rising edge
      // (false -> true), so sustained motion that emits repeated `true`s does
      // not queue extra clips once cooldown/no-overlap would otherwise allow it.
      camera.onMotionDetected.subscribe((active: boolean) => {
        if (active && !state.motionActive) trigger('motion');
        state.motionActive = active;
      }),
    );
  }

  if (cfg.recordOnDing && camera.isDoorbot) {
    subs.push(
      camera.onDoorbellPressed.subscribe(() => trigger('doorbell ding')),
    );
  }

  const triggers: string[] = [];
  if (cfg.recordOnMotion) triggers.push('motion');
  if (cfg.recordOnDing && camera.isDoorbot) triggers.push('ding');
  log.info(
    `Watching "${camera.name}" (#${camera.id})` +
      (triggers.length ? ` for: ${triggers.join(', ')}` : ' (no auto-triggers enabled)'),
  );

  return subs;
}
