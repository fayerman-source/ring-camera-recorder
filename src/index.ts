import type { Subscription } from 'rxjs';
import { loadConfig } from './config.js';
import { createRingApi, getSelectedCameras } from './ring.js';
import { watchCamera } from './events.js';
import { startRetention } from './retention.js';
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
  const cameras = await getSelectedCameras(api, cfg);

  if (cameras.length === 0) {
    log.error('No cameras to watch. Check the `cameras` filter in config.json. Exiting.');
    process.exit(1);
  }

  const subs: Subscription[] = [];
  for (const camera of cameras) {
    subs.push(...watchCamera(camera, cfg));
  }

  const stopRetention = startRetention(cfg);
  log.info(`Ready. Watching ${cameras.length} camera(s). Press Ctrl-C to stop.`);

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down.`);
    for (const s of subs) s.unsubscribe();
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
