// Hermetic tests for detection-context parsing, latency arithmetic and the
// snapshot/timing wiring. No Ring account or network required.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNotification,
  pickDetection,
  buildTimingRecord,
  detectionSnapshotPath,
} from '../dist/detection.js';
import { appendJsonLine } from '../dist/files.js';
import { watchCamera } from '../dist/events.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

const EVENT_AT = Date.parse('2026-07-29T18:59:54.000Z');

/** Minimal Ring motion push, shaped like PushNotificationDingV2. */
const push = (over = {}) => ({
  analytics: { triggered_at: EVENT_AT, sent_at: EVENT_AT + 1_000 },
  data: {
    event: {
      ding: { id: 'ding-1', created_at: '2026-07-29T18:59:54.000Z', subtype: 'motion' },
    },
  },
  img: { snapshot_uuid: 'snap-uuid-1' },
  ...over,
});

describe('detection: parseNotification', () => {
  test('lifts ding id, subtype, detection time and snapshot uuid', () => {
    const d = parseNotification(push(), 1785351596454);
    assert.equal(d.dingId, 'ding-1');
    assert.equal(d.subtype, 'motion');
    assert.equal(d.ringEventAtMs, Date.parse('2026-07-29T18:59:54.000Z'));
    assert.equal(d.snapshotUuid, 'snap-uuid-1');
    assert.equal(d.receivedAtMs, 1785351596454);
  });

  test('falls back to analytics.triggered_at when created_at is absent', () => {
    const n = push();
    delete n.data.event.ding.created_at;
    assert.equal(parseNotification(n, 1).ringEventAtMs, EVENT_AT);
  });

  test('leaves detection time undefined when both sources are unusable', () => {
    const n = push({ analytics: {} });
    n.data.event.ding.created_at = 'not-a-date';
    assert.equal(parseNotification(n, 1).ringEventAtMs, undefined);
  });

  test('tolerates a push with no img and no event payload', () => {
    const d = parseNotification({}, 42);
    assert.equal(d.snapshotUuid, undefined);
    assert.equal(d.dingId, undefined);
    assert.equal(d.receivedAtMs, 42, 'still records when we saw it');
  });
});

describe('detection: pickDetection', () => {
  const ctx = (receivedAtMs) => ({ receivedAtMs, snapshotUuid: 'u' });

  test('accepts a notification from just before the trigger', () => {
    assert.ok(pickDetection(ctx(1_000), 1_200, 15_000));
  });

  test('rejects a stale notification rather than mispairing it', () => {
    assert.equal(pickDetection(ctx(1_000), 1_000 + 20_000, 15_000), undefined);
  });

  test('rejects a notification timestamped after the trigger', () => {
    assert.equal(pickDetection(ctx(5_000), 4_000, 15_000), undefined);
  });

  test('returns undefined when no notification was ever seen', () => {
    assert.equal(pickDetection(undefined, 1, 15_000), undefined);
  });
});

describe('detection: buildTimingRecord', () => {
  const base = {
    cameraName: 'Front',
    clipFile: 'Front_x.mp4',
    snapshotFile: 'Front_x.detection.jpg',
    detection: { dingId: 'd', subtype: 'motion', ringEventAtMs: 10_000, receivedAtMs: 12_270 },
    timing: { triggerAtMs: 12_300, streamOpenAtMs: 16_050, firstFrameAtMs: 18_500 },
  };

  test('computes each latency segment and the total blind window', () => {
    const r = buildTimingRecord(base);
    assert.equal(r.pushDelaySec, 2.27, 'Ring detection -> push received');
    assert.equal(r.streamSetupSec, 3.75, 'trigger -> stream negotiated');
    assert.equal(r.firstFrameSec, 2.45, 'stream open -> first bytes');
    assert.equal(r.blindWindowSec, 8.5, 'Ring detection -> first bytes');
  });

  test('serialises timestamps as ISO strings', () => {
    const r = buildTimingRecord(base);
    assert.equal(r.ringEventAt, new Date(10_000).toISOString());
    assert.equal(r.firstFrameAt, new Date(18_500).toISOString());
  });

  test('nulls the segments it cannot compute instead of emitting NaN', () => {
    const r = buildTimingRecord({ ...base, detection: undefined, timing: { triggerAtMs: 12_300 } });
    assert.equal(r.pushDelaySec, null);
    assert.equal(r.blindWindowSec, null);
    assert.equal(r.streamSetupSec, null);
    assert.equal(r.ringEventAt, null);
    assert.equal(r.triggerAt, new Date(12_300).toISOString(), 'trigger time is always known');
  });

  test('records a null snapshot without dropping the timing row', () => {
    const r = buildTimingRecord({ ...base, snapshotFile: null });
    assert.equal(r.detectionSnapshot, null);
    assert.equal(r.blindWindowSec, 8.5);
  });
});

describe('detection: helpers', () => {
  test('snapshot path is a sibling .detection.jpg', () => {
    assert.equal(detectionSnapshotPath('/x/Front_ts.mp4'), '/x/Front_ts.detection.jpg');
    assert.equal(detectionSnapshotPath('/x/Front_ts.MP4'), '/x/Front_ts.detection.jpg');
  });

  test('appendJsonLine writes one JSON line per call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ring-jsonl-'));
    const f = join(dir, 'timing.jsonl');
    assert.equal(appendJsonLine(f, { a: 1 }), true);
    assert.equal(appendJsonLine(f, { a: 2 }), true);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), { a: 2 });
  });

  test('appendJsonLine reports failure instead of throwing', () => {
    // A path whose parent does not exist — must not throw, since the clip it
    // describes has already been saved successfully.
    assert.equal(appendJsonLine('/nonexistent-dir-xyz/timing.jsonl', { a: 1 }), false);
  });
});

describe('detection: watchCamera wiring', () => {
  function obs() {
    const subs = [];
    return {
      subscribe(fn) {
        subs.push(fn);
        return { unsubscribe() {} };
      },
      next(v) {
        subs.forEach((f) => f(v));
      },
    };
  }

  const setup = (over = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'ring-wire-'));
    const camera = {
      name: 'Front',
      id: 1,
      isDoorbot: false,
      onMotionDetected: obs(),
      onDoorbellPressed: obs(),
      onNewNotification: obs(),
    };
    const cfg = {
      outputDir: dir,
      clipLengthSeconds: 10,
      recordOnMotion: true,
      recordOnDing: true,
      motionCooldownSeconds: 0,
      detectionSnapshots: true,
      timingLog: true,
      ...over,
    };
    const clipPath = join(dir, 'Front_x.mp4');
    // Timings must be anchored to the fixture push's detection time, or the
    // computed blind window is meaningless.
    const recordFn = async () => ({
      camera: 'Front',
      path: clipPath,
      bytes: 1,
      seconds: 10,
      timing: {
        triggerAtMs: EVENT_AT + 2_270,
        streamOpenAtMs: EVENT_AT + 6_020,
        firstFrameAtMs: EVENT_AT + 8_500,
      },
    });
    return { dir, camera, cfg, clipPath, recordFn };
  };

  test('saves the detection snapshot and a timing row on a motion trigger', async () => {
    const { dir, camera, cfg, recordFn } = setup();
    const asked = [];
    const snapshotFn = async (_cam, uuid) => {
      asked.push(uuid);
      return Buffer.from('jpeg-bytes');
    };
    watchCamera(camera, cfg, recordFn, snapshotFn);

    camera.onNewNotification.next(push());
    camera.onMotionDetected.next(true);
    await tick();

    assert.deepEqual(asked, ['snap-uuid-1'], 'fetched the uuid from the push');
    assert.equal(readFileSync(join(dir, 'Front_x.detection.jpg'), 'utf8'), 'jpeg-bytes');

    const row = JSON.parse(readFileSync(join(dir, 'timing.jsonl'), 'utf8').trim());
    assert.equal(row.detectionSnapshot, 'Front_x.detection.jpg');
    assert.equal(row.blindWindowSec, 8.5);
    assert.equal(row.subtype, 'motion');
  });

  test('still records when the push carried no snapshot uuid', async () => {
    const { dir, camera, cfg, recordFn } = setup();
    let called = 0;
    const snapshotFn = async () => {
      called++;
      return Buffer.from('x');
    };
    watchCamera(camera, cfg, recordFn, snapshotFn);

    camera.onNewNotification.next(push({ img: undefined }));
    camera.onMotionDetected.next(true);
    await tick();

    assert.equal(called, 0, 'nothing to fetch');
    assert.ok(!existsSync(join(dir, 'Front_x.detection.jpg')));
    const row = JSON.parse(readFileSync(join(dir, 'timing.jsonl'), 'utf8').trim());
    assert.equal(row.detectionSnapshot, null, 'timing row still written');
  });

  test('a failing snapshot fetch does not fail the recording', async () => {
    const { dir, camera, cfg, recordFn } = setup();
    const snapshotFn = async () => {
      throw new Error('uuid expired');
    };
    watchCamera(camera, cfg, recordFn, snapshotFn);

    camera.onNewNotification.next(push());
    camera.onMotionDetected.next(true);
    await tick();

    const row = JSON.parse(readFileSync(join(dir, 'timing.jsonl'), 'utf8').trim());
    assert.equal(row.detectionSnapshot, null);
    assert.equal(row.blindWindowSec, 8.5, 'latency still recorded');
  });

  test('detectionSnapshots=false skips the fetch entirely', async () => {
    const { camera, cfg, recordFn } = setup({ detectionSnapshots: false });
    let called = 0;
    watchCamera(camera, cfg, recordFn, async () => {
      called++;
      return Buffer.from('x');
    });

    camera.onNewNotification.next(push());
    camera.onMotionDetected.next(true);
    await tick();
    assert.equal(called, 0);
  });

  test('works when the camera exposes no notification stream', async () => {
    const { dir, camera, cfg, recordFn } = setup();
    delete camera.onNewNotification;
    watchCamera(camera, cfg, recordFn, async () => Buffer.from('x'));

    camera.onMotionDetected.next(true);
    await tick();

    const row = JSON.parse(readFileSync(join(dir, 'timing.jsonl'), 'utf8').trim());
    assert.equal(row.dingId, null, 'no detection context to attach');
    assert.equal(row.streamSetupSec, 3.75, 'our own timings are still recorded');
  });
});
