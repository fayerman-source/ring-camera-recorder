// Hermetic tests for the missed-event check: Ring logged an event that never
// arrived as a push. No Ring account or network required.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMissedEvents,
  startMissedEventCheck,
  PUSH_GRACE_MS,
  PUSH_EARLY_SLACK_MS,
} from '../dist/missed.js';

const T = Date.parse('2026-11-07T04:25:27.000Z');
const ev = (atMs, kind = 'motion') => ({ created_at: new Date(atMs).toISOString(), kind, ding_id_str: String(atMs) });

describe('missed: findMissedEvents', () => {
  test('an event with a push shortly after it is not missed', () => {
    assert.deepEqual(findMissedEvents([ev(T)], [T + 2_300], T - 1, T + 1), []);
  });

  test('an event with no push is missed', () => {
    assert.equal(findMissedEvents([ev(T)], [], T - 1, T + 1).length, 1);
  });

  test('a push outside the match window does not count', () => {
    const late = T + PUSH_GRACE_MS + 1;
    const early = T - PUSH_EARLY_SLACK_MS - 1;
    assert.equal(findMissedEvents([ev(T)], [late, early], T - 1, T + 1).length, 1);
  });

  test('ignores kinds that never produce a push, like on_demand live views', () => {
    assert.deepEqual(findMissedEvents([ev(T, 'on_demand')], [], T - 1, T + 1), []);
  });

  test('checks doorbell dings too', () => {
    assert.equal(findMissedEvents([ev(T, 'ding')], [], T - 1, T + 1).length, 1);
  });

  test('only judges events inside [from, to)', () => {
    const events = [ev(T - 10), ev(T), ev(T + 10)];
    assert.deepEqual(
      findMissedEvents(events, [], T, T + 10).map((e) => e.created_at),
      [new Date(T).toISOString()],
    );
  });

  test('skips events with an unparseable timestamp', () => {
    assert.deepEqual(findMissedEvents([{ created_at: 'nope', kind: 'motion' }], [], 0, Infinity), []);
  });
});

describe('missed: startMissedEventCheck', () => {
  function obs() {
    const fns = new Set();
    return {
      subscribe(fn) {
        fns.add(fn);
        return { unsubscribe: () => fns.delete(fn) };
      },
      next(v) {
        for (const fn of fns) fn(v);
      },
      get size() {
        return fns.size;
      },
    };
  }

  const setup = (events) => {
    let now = T - 60_000; // service starts a minute before the walk-past
    const camera = {
      id: 1,
      name: 'Front',
      onNewNotification: obs(),
      getEvents: async () => ({ events: events() }),
    };
    const cfg = { missedEventCheckMinutes: 15 };
    const check = startMissedEventCheck([camera], cfg, () => now);
    return { camera, check, advance: (ms) => (now += ms), at: () => now };
  };

  const captureWarnings = async (fn) => {
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).includes('[WARN]')) lines.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = orig;
    }
    return lines;
  };

  test('warns when Ring logged motion that never arrived as a push', async () => {
    const { check, advance } = setup(() => [ev(T)]);
    advance(60_000 + PUSH_GRACE_MS + 1);
    const warnings = await captureWarnings(() => check.sweep());
    check.stop();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Ring logged 1 event on "Front" that never arrived as a push/);
  });

  test('stays quiet when the push was received', async () => {
    const { camera, check, advance } = setup(() => [ev(T)]);
    advance(60_000 + 2_300);
    camera.onNewNotification.next({});
    advance(PUSH_GRACE_MS);
    const warnings = await captureWarnings(() => check.sweep());
    check.stop();
    assert.deepEqual(warnings, []);
  });

  test('judges each event once, and only after the grace period', async () => {
    const { check, advance } = setup(() => [ev(T)]);
    advance(60_000 + 1_000); // event happened, grace not yet over
    assert.deepEqual(await captureWarnings(() => check.sweep()), [], 'too early to judge');
    advance(PUSH_GRACE_MS);
    assert.equal((await captureWarnings(() => check.sweep())).length, 1);
    advance(15 * 60_000);
    assert.deepEqual(await captureWarnings(() => check.sweep()), [], 'not reported twice');
    check.stop();
  });

  test('ignores events from before the service started', async () => {
    const { check, advance } = setup(() => [ev(T - 5 * 60_000)]);
    advance(60_000 + PUSH_GRACE_MS + 1);
    assert.deepEqual(await captureWarnings(() => check.sweep()), []);
    check.stop();
  });

  test('a failing history fetch is reported, not thrown', async () => {
    let now = T;
    const camera = {
      id: 1,
      name: 'Front',
      onNewNotification: obs(),
      getEvents: async () => {
        throw new Error('rate limited');
      },
    };
    const check = startMissedEventCheck([camera], { missedEventCheckMinutes: 15 }, () => now);
    now += PUSH_GRACE_MS + 1;
    const warnings = await captureWarnings(() => check.sweep());
    check.stop();
    assert.match(warnings[0], /could not read Ring's history for "Front": rate limited/);
  });

  test('disabled when missedEventCheckMinutes is 0 or null', async () => {
    for (const minutes of [0, null]) {
      const camera = { id: 1, name: 'Front', onNewNotification: obs(), getEvents: async () => ({ events: [ev(T)] }) };
      const check = startMissedEventCheck([camera], { missedEventCheckMinutes: minutes }, () => T + 10 * PUSH_GRACE_MS);
      assert.deepEqual(await captureWarnings(() => check.sweep()), []);
      assert.equal(camera.onNewNotification.size, 0, 'no push subscription when disabled');
      check.stop();
    }
  });

  test('stop() releases the push subscription', () => {
    const { camera, check } = setup(() => []);
    assert.equal(camera.onNewNotification.size, 1);
    check.stop();
    assert.equal(camera.onNewNotification.size, 0);
  });
});
