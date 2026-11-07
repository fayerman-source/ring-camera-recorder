import { log } from './log.js';

/**
 * Re-subscribe cameras to motion/ding events once Ring knows our push token.
 *
 * Ported from upstream dgreif/ring PR #1879. Cameras call `motions_subscribe`
 * and `subscribe` as soon as ring-client-api creates them, but the FCM push
 * token is only registered with Ring (`PATCH clients_api/device`) after the
 * push receiver connects. On the first run after `npm run auth`, the
 * subscriptions therefore land before Ring has a token for this device, and no
 * motion events are delivered until the service restarts.
 *
 * ring-client-api has no event for "token registered", but it does rotate the
 * refresh token when it stores new push credentials (they are embedded in the
 * token). We watch for the embedded push token changing, wait for the device
 * PATCH to land, then subscribe every camera again. Both subscribe calls are
 * idempotent on Ring's side, so an extra one is harmless.
 */

/** Delay between the credential rotation and re-subscribing. The device PATCH
 *  is sent right after the rotation and normally completes well inside this. */
export const RESUBSCRIBE_DELAY_MS = 5000;

export interface TokenUpdate {
  oldRefreshToken?: string;
  newRefreshToken: string;
}

/** The subset of an rxjs Observable we use, so tests can pass a plain fake. */
export interface TokenUpdates {
  subscribe(fn: (update: TokenUpdate) => void): { unsubscribe(): void };
}

export interface Resubscribable {
  name: string;
  subscribeToMotionEvents(): Promise<unknown>;
  subscribeToDingEvents(): Promise<unknown>;
}

/**
 * Extract the FCM push token embedded in a ring-client-api refresh token.
 * The token is base64 JSON `{ rt, hid, pnc? }`; returns undefined when it has
 * no push credentials or is not in that format.
 */
export function pushTokenOf(refreshToken: string | undefined): string | undefined {
  if (!refreshToken) return undefined;
  try {
    const config = JSON.parse(Buffer.from(refreshToken, 'base64').toString('utf8'));
    const token = config?.pnc?.fcm?.token;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface PushResubscriber {
  /** Provide the cameras to re-subscribe. A rotation seen earlier is applied now. */
  setCameras(cameras: readonly Resubscribable[]): void;
  stop(): void;
}

/**
 * Start watching token updates. Call this right after creating the RingApi and
 * before `getCameras()`: push registration starts during camera discovery and
 * can finish before the cameras are handed back.
 */
export function watchPushRegistration(
  updates: TokenUpdates,
  delayMs: number = RESUBSCRIBE_DELAY_MS,
): PushResubscriber {
  let cameras: readonly Resubscribable[] | null = null;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;

  const resubscribe = async (targets: readonly Resubscribable[]) => {
    const calls = targets.flatMap((camera) => [
      { camera, kind: 'motion', run: () => camera.subscribeToMotionEvents() },
      { camera, kind: 'ding', run: () => camera.subscribeToDingEvents() },
    ]);
    // Promise.resolve().then(...) turns a synchronous throw into a rejection,
    // so one bad camera cannot stop the others from re-subscribing.
    const results = await Promise.allSettled(calls.map((c) => Promise.resolve().then(c.run)));
    let failed = 0;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        failed++;
        const { camera, kind } = calls[i];
        log.error(
          `Re-subscribing "${camera.name}" to ${kind} events failed: ${(result.reason as Error)?.message ?? result.reason}`,
        );
      }
    });
    if (failed === 0) {
      log.info(`Push token registered with Ring; re-subscribed ${targets.length} camera(s) to events.`);
    }
  };

  const schedule = () => {
    if (!cameras) {
      pending = true;
      return;
    }
    const targets = cameras;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      resubscribe(targets).catch((err) => log.error(`Re-subscribe failed: ${(err as Error).message}`));
    }, delayMs);
  };

  const sub = updates.subscribe(({ oldRefreshToken, newRefreshToken }) => {
    const next = pushTokenOf(newRefreshToken);
    if (!next || next === pushTokenOf(oldRefreshToken)) return;
    schedule();
  });

  return {
    setCameras(next) {
      cameras = next;
      if (pending) {
        pending = false;
        schedule();
      }
    },
    stop() {
      sub.unsubscribe();
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
