// Hermetic tests for re-subscribing after push token registration (port of
// upstream dgreif/ring PR #1879). No Ring account or network required.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pushTokenOf, watchPushRegistration } from '../dist/push.js';

const DELAY = 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(DELAY * 4);

/** Build a refresh token in ring-client-api's format: base64 JSON { rt, hid, pnc? }. */
const token = (rt, fcmToken) =>
  Buffer.from(
    JSON.stringify({ rt, hid: 'hid-1', ...(fcmToken ? { pnc: { fcm: { token: fcmToken } } } : {}) }),
  ).toString('base64');

/** Minimal stand-in for api.onRefreshTokenUpdated. */
function fakeUpdates() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return { unsubscribe: () => listeners.delete(fn) };
    },
    emit(update) {
      for (const fn of listeners) fn(update);
    },
    get size() {
      return listeners.size;
    },
  };
}

function fakeCamera(name, { failMotion = false } = {}) {
  const calls = [];
  return {
    name,
    calls,
    subscribeToMotionEvents() {
      calls.push('motion');
      return failMotion ? Promise.reject(new Error('boom')) : Promise.resolve();
    },
    subscribeToDingEvents() {
      calls.push('ding');
      return Promise.resolve();
    },
  };
}

describe('push: pushTokenOf', () => {
  test('extracts the embedded FCM token', () => {
    assert.equal(pushTokenOf(token('rt-1', 'fcm-abc')), 'fcm-abc');
  });

  test('undefined when the token has no push credentials', () => {
    assert.equal(pushTokenOf(token('rt-1')), undefined);
  });

  test('undefined for missing or malformed tokens', () => {
    assert.equal(pushTokenOf(undefined), undefined);
    assert.equal(pushTokenOf('not-base64-json'), undefined);
  });
});

describe('push: watchPushRegistration', () => {
  test('re-subscribes motion and ding after push credentials are added', async () => {
    const updates = fakeUpdates();
    const cam = fakeCamera('Front');
    const push = watchPushRegistration(updates, DELAY);
    push.setCameras([cam]);

    updates.emit({ oldRefreshToken: token('rt-1'), newRefreshToken: token('rt-2', 'fcm-abc') });
    assert.deepEqual(cam.calls, [], 'waits for the device PATCH before re-subscribing');
    await settle();
    assert.deepEqual(cam.calls.sort(), ['ding', 'motion']);
    push.stop();
  });

  test('a registration seen before cameras are known is applied once they are set', async () => {
    const updates = fakeUpdates();
    const cam = fakeCamera('Front');
    const push = watchPushRegistration(updates, DELAY);

    updates.emit({ oldRefreshToken: token('rt-1'), newRefreshToken: token('rt-2', 'fcm-abc') });
    await settle();
    push.setCameras([cam]);
    await settle();
    assert.deepEqual(cam.calls.sort(), ['ding', 'motion']);
    push.stop();
  });

  test('ignores plain rotations that keep the same push token', async () => {
    const updates = fakeUpdates();
    const cam = fakeCamera('Front');
    const push = watchPushRegistration(updates, DELAY);
    push.setCameras([cam]);

    updates.emit({ oldRefreshToken: token('rt-1', 'fcm-abc'), newRefreshToken: token('rt-2', 'fcm-abc') });
    updates.emit({ oldRefreshToken: token('rt-2'), newRefreshToken: token('rt-3') });
    await settle();
    assert.deepEqual(cam.calls, []);
    push.stop();
  });

  test('re-subscribes when the push token is replaced', async () => {
    const updates = fakeUpdates();
    const cam = fakeCamera('Front');
    const push = watchPushRegistration(updates, DELAY);
    push.setCameras([cam]);

    updates.emit({ oldRefreshToken: token('rt-1', 'fcm-old'), newRefreshToken: token('rt-2', 'fcm-new') });
    await settle();
    assert.deepEqual(cam.calls.sort(), ['ding', 'motion']);
    push.stop();
  });

  test('one failing camera does not stop the others', async () => {
    const updates = fakeUpdates();
    const bad = fakeCamera('Bad', { failMotion: true });
    const good = fakeCamera('Good');
    const push = watchPushRegistration(updates, DELAY);
    push.setCameras([bad, good]);

    updates.emit({ oldRefreshToken: token('rt-1'), newRefreshToken: token('rt-2', 'fcm-abc') });
    await settle();
    assert.deepEqual(good.calls.sort(), ['ding', 'motion']);
    assert.deepEqual(bad.calls.sort(), ['ding', 'motion']);
    push.stop();
  });

  test('stop() unsubscribes and cancels a pending re-subscribe', async () => {
    const updates = fakeUpdates();
    const cam = fakeCamera('Front');
    const push = watchPushRegistration(updates, DELAY);
    push.setCameras([cam]);

    updates.emit({ oldRefreshToken: token('rt-1'), newRefreshToken: token('rt-2', 'fcm-abc') });
    push.stop();
    await settle();
    assert.deepEqual(cam.calls, []);
    assert.equal(updates.size, 0);
  });
});

describe('push: waitForPushRegistration', () => {
  test('resolves true once push credentials appear, after the settle delay', async () => {
    const updates = fakeUpdates();
    const { waitForPushRegistration } = await import('../dist/push.js');
    let settled;
    const p = waitForPushRegistration(updates, 1_000, DELAY).then((ok) => (settled = ok));

    updates.emit({ oldRefreshToken: token('rt-0'), newRefreshToken: token('rt-1') });
    await wait(DELAY * 2);
    assert.equal(settled, undefined, 'a rotation without push credentials does not count');

    updates.emit({ oldRefreshToken: token('rt-1'), newRefreshToken: token('rt-2', 'fcm-abc') });
    assert.equal(await p, true);
    assert.equal(updates.size, 0, 'unsubscribes when done');
  });

  test('resolves false on timeout', async () => {
    const updates = fakeUpdates();
    const { waitForPushRegistration } = await import('../dist/push.js');
    assert.equal(await waitForPushRegistration(updates, DELAY, DELAY), false);
    assert.equal(updates.size, 0);
  });
});
