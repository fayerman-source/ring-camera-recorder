// Hermetic logic tests — no Ring account or network required.
// Run with: npm test   (builds to dist/ first, then runs this against dist).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clipFilename, slugify, pruneOldClips, ensureDir } from '../dist/files.js';
import { watchCamera } from '../dist/events.js';
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('files: naming', () => {
  test('filename keeps ms, colons stripped (no same-second collision)', () => {
    const name = clipFilename('Front Door!', new Date('2026-06-17T14:03:22.500Z'));
    assert.match(name, /^Front-Door_2026-06-17T14-03-22-500Z\.mp4$/);
  });

  test('slugify sanitizes unsafe chars', () => {
    assert.equal(slugify('   Backyard / Garage  '), 'Backyard-Garage');
  });

  test('slugify falls back to "camera" for empty result', () => {
    assert.equal(slugify('***'), 'camera');
  });
});

describe('files: retention', () => {
  /** Fresh dir per test: one >7d clip, one fresh clip, one non-mp4 file. */
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ring-ret-'));
    ensureDir(dir);
    const old = join(dir, 'Cam_old.mp4');
    writeFileSync(old, 'x');
    writeFileSync(join(dir, 'Cam_fresh.mp4'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const tenDaysAgo = Date.now() / 1000 - 10 * 86400;
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    return dir;
  };

  test('prunes exactly the >7d clip', () => {
    const deleted = pruneOldClips(setup(), 7, new Date());
    assert.equal(deleted.length, 1);
    assert.ok(deleted[0].endsWith('Cam_old.mp4'), 'deleted the old clip');
  });

  test('keeps the fresh clip', () => {
    const dir = setup();
    pruneOldClips(dir, 7, new Date());
    assert.ok(readdirSync(dir).includes('Cam_fresh.mp4'));
  });

  test('leaves non-mp4 files untouched', () => {
    const dir = setup();
    pruneOldClips(dir, 7, new Date());
    assert.ok(readdirSync(dir).includes('notes.txt'));
  });

  test('retention=null is a no-op', () => {
    const dir = setup();
    assert.equal(pruneOldClips(dir, null, new Date()).length, 0);
    assert.equal(readdirSync(dir).length, 3, 'nothing was deleted');
  });
});

describe('events: motion/ding trigger state machine', () => {
  /** Minimal stand-in for an rxjs Observable — just enough for watchCamera. */
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

  const fakeCamera = (isDoorbot) => ({
    name: 'TestCam',
    id: 42,
    isDoorbot,
    onMotionDetected: obs(),
    onDoorbellPressed: obs(),
  });

  const cfg = (over = {}) => ({
    clipLengthSeconds: 10,
    recordOnMotion: true,
    recordOnDing: true,
    motionCooldownSeconds: 0,
    ...over,
  });

  /** Stands in for recordClip: records the calls and lets the test resolve them. */
  function spy() {
    const calls = [];
    let resolveLast;
    const fn = (camera, c, seconds) => {
      calls.push({ seconds });
      return new Promise((res) => {
        resolveLast = () => res({ camera: camera.name, path: 'x', bytes: 1, seconds });
      });
    };
    return { fn, calls, finish: () => resolveLast?.() };
  }

  test('records once per false->true transition, not while motion stays true', async () => {
    const cam = fakeCamera(false);
    const s = spy();
    watchCamera(cam, cfg(), s.fn);

    cam.onMotionDetected.next(false);
    await tick();
    assert.equal(s.calls.length, 0, 'motion=false does not trigger');

    cam.onMotionDetected.next(true);
    await tick();
    assert.equal(s.calls.length, 1, 'rising edge (false->true) records one clip');
    assert.equal(s.calls[0].seconds, 10, 'used the configured clip length');

    cam.onMotionDetected.next(true);
    await tick();
    assert.equal(s.calls.length, 1, 'sustained true (no new rising edge) does not re-trigger');

    s.finish();
    await tick();
    cam.onMotionDetected.next(false);
    await tick();
    cam.onMotionDetected.next(true);
    await tick();
    assert.equal(s.calls.length, 2, 'a new rising edge after motion ends triggers again');
  });

  test('skips a new rising edge that lands inside the cooldown window', async () => {
    const cam = fakeCamera(false);
    const s = spy();
    watchCamera(cam, cfg({ motionCooldownSeconds: 3600 }), s.fn);

    cam.onMotionDetected.next(true);
    await tick();
    s.finish();
    await tick();
    cam.onMotionDetected.next(false);
    await tick();
    cam.onMotionDetected.next(true);
    await tick();
    assert.equal(s.calls.length, 1);
  });

  test('ignores motion when recordOnMotion=false but still records a ding', async () => {
    const cam = fakeCamera(true);
    const s = spy();
    watchCamera(cam, cfg({ recordOnMotion: false }), s.fn);

    cam.onMotionDetected.next(true);
    await tick();
    assert.equal(s.calls.length, 0, 'motion ignored when recordOnMotion=false');

    cam.onDoorbellPressed.next({});
    await tick();
    assert.equal(s.calls.length, 1, 'doorbell ding triggers a recording');
  });

  test('ignores a ding on a camera that is not a doorbell', async () => {
    const cam = fakeCamera(false);
    const s = spy();
    watchCamera(cam, cfg(), s.fn);

    cam.onDoorbellPressed.next({});
    await tick();
    assert.equal(s.calls.length, 0);
  });
});
