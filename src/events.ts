import type { Subscription } from 'rxjs';
import type { RingCamera } from 'ring-client-api';
import type { AppConfig } from './config.js';
import { recordClip, type RecordResult } from './recorder.js';
import { log } from './log.js';

/** Recorder function shape — injectable so the trigger logic is unit-testable. */
export type RecordFn = (camera: RingCamera, cfg: AppConfig, seconds: number) => Promise<RecordResult>;

/** Per-camera runtime state used to debounce overlapping triggers. */
interface CameraState {
  recording: boolean;
  lastStartMs: number;
  motionActive: boolean;
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
export function watchCamera(camera: RingCamera, cfg: AppConfig, recordFn: RecordFn = recordClip): Subscription[] {
  const state: CameraState = { recording: false, lastStartMs: 0, motionActive: false };
  const subs: Subscription[] = [];

  const trigger = (reason: string) => {
    const now = Date.now();
    if (!shouldTrigger(state, cfg, now)) {
      log.debug(`Ignoring ${reason} on "${camera.name}" (busy or within cooldown).`);
      return;
    }
    state.recording = true;
    state.lastStartMs = now;
    log.info(`Trigger: ${reason} on "${camera.name}".`);
    recordFn(camera, cfg, cfg.clipLengthSeconds)
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
