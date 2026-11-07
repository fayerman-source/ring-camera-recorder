import type { Subscription } from 'rxjs';
import { loadConfig } from './config.js';
import { createRingApi, getSelectedCameras } from './ring.js';
import { watchCamera } from './events.js';
import { watchPushRegistration } from './push.js';
import { startRetention } from './retention.js';
import { startMissedEventCheck } from './missed.js';
import { log } from './log.js';

/**
 * Long-running service: connect to Ring, watch the selected cameras for motion /
 * doorbell events, and auto-record live clips. Also runs retention cleanup.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info('Starting Ring local recorder.');
  log.info(`Output: ${cfg.outputDir} | clip: ${cfg.clipLengthSeconds}s | cameras: ${JSON.stringify(cfg.cameras)}`);

  const api = createRingApi(cfg);
  // Subscribe before camera discovery: push registration starts during it and
  // can finish before getCameras() resolves.
  const push = watchPushRegistration(api.onRefreshTokenUpdated);
  const cameras = await getSelectedCameras(api, cfg);

  if (cameras.length === 0) {
    log.error('No cameras to watch. Check the `cameras` filter in config.json. Exiting.');
    process.exit(1);
  }

  push.setCameras(cameras);

  const subs: Subscription[] = [];
  for (const camera of cameras) {
    subs.push(...watchCamera(camera, cfg));
  }

  const stopRetention = startRetention(cfg);
  const missedCheck = startMissedEventCheck(cameras, cfg);
  log.info(`Ready. Watching ${cameras.length} camera(s). Press Ctrl-C to stop.`);

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down.`);
    for (const s of subs) s.unsubscribe();
    push.stop();
    missedCheck.stop();
    stopRetention();
    api.disconnect();
    // Give in-flight ffmpeg writes a moment to flush before exit.
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
