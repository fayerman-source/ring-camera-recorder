import type { RingCamera } from 'ring-client-api';
import type { AppConfig } from './config.js';
import { log } from './log.js';

/**
 * Missed-event check: catch the failure where Ring keeps detecting motion but
 * its push notifications never reach this service.
 *
 * That failure is silent. The service stays up, logs nothing, and records
 * nothing, while the Ring app shows every event. (Causes seen so far: a
 * push-receiver that can't decrypt Firebase's format, stale device
 * registrations in Ring's Control Center, and subscriptions made before the
 * push token was registered.) Ring's event history is the ground truth, so we
 * periodically compare it against the pushes we actually received.
 */

/** Ring event kinds that should each arrive as a push. */
const PUSH_KINDS = new Set(['motion', 'ding']);

/** A push may legitimately arrive this long after Ring logs the event. */
export const PUSH_GRACE_MS = 2 * 60_000;
/** Clock skew allowance: a push stamped slightly before Ring's event time. */
export const PUSH_EARLY_SLACK_MS = 15_000;

export interface RingEventLike {
  created_at: string;
  kind: string;
  ding_id_str?: string;
}

/**
 * Return the Ring events in `[fromMs, toMs)` that no received push accounts
 * for. A push matches an event when it was received between
 * `PUSH_EARLY_SLACK_MS` before and `PUSH_GRACE_MS` after the event. Matching
 * is by time rather than ding id: Ring's ids exceed 2^53 and lose precision
 * once a push payload is JSON-parsed into a number.
 */
export function findMissedEvents(
  events: readonly RingEventLike[],
  pushReceivedAtMs: readonly number[],
  fromMs: number,
  toMs: number,
): RingEventLike[] {
  return events.filter((event) => {
    if (!PUSH_KINDS.has(event.kind)) return false;
    const at = Date.parse(event.created_at);
    if (!Number.isFinite(at) || at < fromMs || at >= toMs) return false;
    return !pushReceivedAtMs.some((p) => p >= at - PUSH_EARLY_SLACK_MS && p <= at + PUSH_GRACE_MS);
  });
}

/** Keep the push log bounded; only the last check window matters. */
const MAX_PUSHES_PER_CAMERA = 500;

export interface MissedEventCheck {
  stop(): void;
  /** Run one sweep now. Exposed for tests. */
  sweep(): Promise<void>;
}

/**
 * Start the periodic check.
 *
 * Each sweep covers `[watermark, now - PUSH_GRACE_MS)` and then advances the
 * watermark, so every Ring event is judged exactly once, after its push has
 * had the full grace period to arrive. Events from before the service started
 * are never judged. Costs one REST call per camera per sweep; it does not wake
 * the camera.
 */
export function startMissedEventCheck(
  cameras: readonly RingCamera[],
  cfg: AppConfig,
  nowFn: () => number = Date.now,
): MissedEventCheck {
  const minutes = cfg.missedEventCheckMinutes;
  if (!minutes || minutes <= 0) {
    log.info('Missed-event check disabled.');
    return { stop: () => {}, sweep: async () => {} };
  }

  const pushes = new Map<number, number[]>();
  const subs = cameras.map((camera) => {
    pushes.set(camera.id, []);
    return camera.onNewNotification.subscribe(() => {
      const list = pushes.get(camera.id)!;
      list.push(nowFn());
      if (list.length > MAX_PUSHES_PER_CAMERA) list.splice(0, list.length - MAX_PUSHES_PER_CAMERA);
    });
  });

  let watermark = nowFn();
  let running = false;

  const checkCamera = async (camera: RingCamera, from: number, to: number) => {
    try {
      const { events } = await camera.getEvents({ limit: 50 });
      const missed = findMissedEvents(events, pushes.get(camera.id) ?? [], from, to);
      if (missed.length === 0) {
        log.debug(`Missed-event check: all Ring events on "${camera.name}" arrived as pushes.`);
        return;
      }
      const latestMs = Math.max(...missed.map((e) => Date.parse(e.created_at)));
      const one = missed.length === 1;
      log.warn(
        `Ring logged ${missed.length} ${one ? 'event' : 'events'} on "${camera.name}" ` +
          `that never arrived as a push notification (latest ${new Date(latestMs).toISOString()}). ` +
          `Nothing was recorded for ${one ? 'it' : 'them'}. See README "Troubleshooting: no motion clips".`,
      );
    } catch (err) {
      log.warn(`Missed-event check could not read Ring's history for "${camera.name}": ${(err as Error).message}`);
    }
  };

  const sweep = async () => {
    if (running) return;
    const to = nowFn() - PUSH_GRACE_MS;
    if (to <= watermark) return;
    running = true;
    try {
      // checkCamera never rejects, so one camera's failure can't skip the others.
      await Promise.all(cameras.map((camera) => checkCamera(camera, watermark, to)));
      watermark = to;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), minutes * 60_000);
  timer.unref();
  log.info(`Missed-event check: comparing Ring's event history with received pushes every ${minutes} min.`);

  return {
    stop() {
      clearInterval(timer);
      for (const s of subs) s.unsubscribe();
    },
    sweep,
  };
}
