import type { PushNotificationDingV2 } from 'ring-client-api';

/**
 * Detection context lifted out of a Ring push notification.
 *
 * The point of this module is latency accounting. A clip can only start after
 * the event reaches us, so the interesting question is *how much happened
 * before the first frame* — and answering it needs Ring's own timestamps, not
 * ours. `ringEventAtMs` is the moment Ring says it detected motion;
 * `receivedAtMs` is when the push landed here. The gap between them is Ring's,
 * and nothing in this repo can shrink it.
 */
export interface DetectionContext {
  dingId?: string;
  /** 'motion' | 'ding' | 'human' | 'other_motion' | ... (Ring's own label). */
  subtype?: string;
  /** Ring's detection timestamp (ms epoch), from ding.created_at or analytics.triggered_at. */
  ringEventAtMs?: number;
  /** UUID of the snapshot Ring captured at detection time, if the push carried one. */
  snapshotUuid?: string;
  /** When this process received the push (ms epoch). */
  receivedAtMs: number;
}

/**
 * Pull the useful fields out of a push notification.
 *
 * Every field is optional in practice: Ring's payload shape varies by device
 * and firmware, and `img` in particular is absent on some cameras. A partial
 * context is still worth recording — a missing snapshot uuid should degrade to
 * "no snapshot", never to a dropped recording.
 */
export function parseNotification(n: PushNotificationDingV2, receivedAtMs: number): DetectionContext {
  const ding = n?.data?.event?.ding;
  const createdAt = ding?.created_at ? Date.parse(ding.created_at) : NaN;
  const triggeredAt = n?.analytics?.triggered_at;

  // Prefer ding.created_at (detection); fall back to analytics.triggered_at.
  let ringEventAtMs: number | undefined;
  if (Number.isFinite(createdAt)) ringEventAtMs = createdAt;
  else if (typeof triggeredAt === 'number' && Number.isFinite(triggeredAt)) ringEventAtMs = triggeredAt;

  return {
    dingId: ding?.id,
    subtype: ding?.subtype,
    ringEventAtMs,
    snapshotUuid: n?.img?.snapshot_uuid,
    receivedAtMs,
  };
}

/**
 * Decide whether a stored notification belongs to the trigger firing now.
 *
 * `onMotionDetected` and `onNewNotification` are separate streams over the same
 * push, so a trigger normally has a notification from milliseconds earlier. A
 * *stale* one must not be attached: motion triggers can also come from a
 * boolean transition with no fresh push behind it, and pairing a clip with a
 * 20-minute-old detection would silently corrupt the latency numbers this
 * module exists to produce. Unrelated is better than wrong.
 */
export function pickDetection(
  latest: DetectionContext | undefined,
  triggerAtMs: number,
  maxAgeMs: number,
): DetectionContext | undefined {
  if (!latest) return undefined;
  const age = triggerAtMs - latest.receivedAtMs;
  if (age < 0 || age > maxAgeMs) return undefined;
  return latest;
}

/** Timestamps collected across one recording attempt (ms epoch). */
export interface CaptureTiming {
  triggerAtMs: number;
  streamOpenAtMs?: number;
  firstFrameAtMs?: number;
}

export interface TimingRecord {
  camera: string;
  clip: string;
  detectionSnapshot: string | null;
  dingId: string | null;
  subtype: string | null;
  ringEventAt: string | null;
  notificationReceivedAt: string | null;
  triggerAt: string;
  streamOpenAt: string | null;
  firstFrameAt: string | null;
  /** Ring detection -> push received here. Ring's latency; not ours. */
  pushDelaySec: number | null;
  /** Trigger -> live stream negotiated (WebRTC signaling + camera wake). */
  streamSetupSec: number | null;
  /** Stream open -> first bytes on disk (ffmpeg stream analysis). */
  firstFrameSec: number | null;
  /** Ring detection -> first bytes on disk. The headline number. */
  blindWindowSec: number | null;
}

const iso = (ms?: number): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
/** Elapsed ms between two epoch timestamps, as seconds to 2dp. */
const secs = (a?: number, b?: number): number | null =>
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / 10) / 100
    : null;

/**
 * Build the JSONL record for one capture. Pure so the arithmetic is testable
 * without a Ring account, a camera, or a clock.
 */
export function buildTimingRecord(args: {
  cameraName: string;
  clipFile: string;
  snapshotFile: string | null;
  detection?: DetectionContext;
  timing: CaptureTiming;
}): TimingRecord {
  const { cameraName, clipFile, snapshotFile, detection, timing } = args;
  return {
    camera: cameraName,
    clip: clipFile,
    detectionSnapshot: snapshotFile,
    dingId: detection?.dingId ?? null,
    subtype: detection?.subtype ?? null,
    ringEventAt: iso(detection?.ringEventAtMs),
    notificationReceivedAt: iso(detection?.receivedAtMs),
    triggerAt: new Date(timing.triggerAtMs).toISOString(),
    streamOpenAt: iso(timing.streamOpenAtMs),
    firstFrameAt: iso(timing.firstFrameAtMs),
    pushDelaySec: secs(detection?.ringEventAtMs, detection?.receivedAtMs),
    streamSetupSec: secs(timing.triggerAtMs, timing.streamOpenAtMs),
    firstFrameSec: secs(timing.streamOpenAtMs, timing.firstFrameAtMs),
    blindWindowSec: secs(detection?.ringEventAtMs, timing.firstFrameAtMs),
  };
}

/** Sibling path for the detection snapshot: Front_<ts>.mp4 -> Front_<ts>.detection.jpg */
export function detectionSnapshotPath(clipPath: string): string {
  return clipPath.replace(/\.mp4$/i, '') + '.detection.jpg';
}
