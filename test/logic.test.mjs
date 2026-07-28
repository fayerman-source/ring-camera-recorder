// Hermetic logic tests — no Ring account or network required.
// Run with: npm test   (builds to dist/ first, then runs this against dist).
import { clipFilename, slugify, pruneOldClips, ensureDir } from '../dist/files.js';
import { watchCamera } from '../dist/events.js';
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tick = () => new Promise((r) => setTimeout(r, 5));
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)));

console.log('files: naming + retention');
{
  const name = clipFilename('Front Door!', new Date('2026-06-17T14:03:22.500Z'));
  ok(/^Front-Door_2026-06-17T14-03-22-500Z\.mp4$/.test(name), 'filename keeps ms, colons stripped (no same-second collision)');
  ok(slugify('   Backyard / Garage  ') === 'Backyard-Garage', 'slugify sanitizes unsafe chars');
  ok(slugify('***') === 'camera', 'slugify falls back to "camera" for empty result');

  const dir = mkdtempSync(join(tmpdir(), 'ring-ret-'));
  ensureDir(dir);
  const old = join(dir, 'Cam_old.mp4'); writeFileSync(old, 'x');
  writeFileSync(join(dir, 'Cam_fresh.mp4'), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const tenDaysAgo = Date.now() / 1000 - 10 * 86400;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  const deleted = pruneOldClips(dir, 7, new Date());
  const left = readdirSync(dir).sort();
  ok(deleted.length === 1 && deleted[0].endsWith('Cam_old.mp4'), 'pruned exactly the >7d clip');
  ok(left.includes('Cam_fresh.mp4'), 'kept the fresh clip');
  ok(left.includes('notes.txt'), 'left non-mp4 file untouched');
  ok(pruneOldClips(dir, null, new Date()).length === 0, 'retention=null is a no-op');
}

console.log('events: motion/ding trigger state machine');
function obs() {
  const subs = [];
  return { subscribe(fn) { subs.push(fn); return { unsubscribe() {} }; }, next(v) { subs.forEach((f) => f(v)); } };
}
const fakeCamera = (isDoorbot) => ({ name: 'TestCam', id: 42, isDoorbot, onMotionDetected: obs(), onDoorbellPressed: obs() });
const cfg = (over = {}) => ({ clipLengthSeconds: 10, recordOnMotion: true, recordOnDing: true, motionCooldownSeconds: 0, ...over });
function spy() {
  const calls = []; let resolveLast;
  const fn = (camera, c, seconds) => { calls.push({ seconds }); return new Promise((res) => { resolveLast = () => res({ camera: camera.name, path: 'x', bytes: 1, seconds }); }); };
  return { fn, calls, finish: () => resolveLast?.() };
}

{
  const cam = fakeCamera(false); const s = spy();
  watchCamera(cam, cfg(), s.fn);
  cam.onMotionDetected.next(false); await tick();
  ok(s.calls.length === 0, 'motion=false does not trigger');
  cam.onMotionDetected.next(true); await tick();
  ok(s.calls.length === 1 && s.calls[0].seconds === 10, 'rising edge (false->true) records one clip');
  cam.onMotionDetected.next(true); await tick();
  ok(s.calls.length === 1, 'sustained true (no new rising edge) does not re-trigger');
  s.finish(); await tick();
  cam.onMotionDetected.next(false); await tick();
  cam.onMotionDetected.next(true); await tick();
  ok(s.calls.length === 2, 'a new rising edge after motion ends triggers again');
}
{
  const cam = fakeCamera(false); const s = spy();
  watchCamera(cam, cfg({ motionCooldownSeconds: 3600 }), s.fn);
  cam.onMotionDetected.next(true); await tick(); s.finish(); await tick();
  cam.onMotionDetected.next(false); await tick();
  cam.onMotionDetected.next(true); await tick();
  ok(s.calls.length === 1, 'new rising edge within cooldown is skipped');
}
{
  const cam = fakeCamera(true); const s = spy();
  watchCamera(cam, cfg({ recordOnMotion: false }), s.fn);
  cam.onMotionDetected.next(true); await tick();
  ok(s.calls.length === 0, 'motion ignored when recordOnMotion=false');
  cam.onDoorbellPressed.next({}); await tick();
  ok(s.calls.length === 1, 'doorbell ding triggers a recording');
}
{
  const cam = fakeCamera(false); const s = spy();
  watchCamera(cam, cfg(), s.fn);
  cam.onDoorbellPressed.next({}); await tick();
  ok(s.calls.length === 0, 'ding on non-doorbot does nothing');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
