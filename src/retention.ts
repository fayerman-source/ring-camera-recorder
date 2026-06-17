import type { AppConfig } from './config.js';
import { pruneOldClips } from './files.js';
import { log } from './log.js';

/**
 * Run one retention sweep now, then on an interval. Returns a stop() to clear
 * the timer on shutdown. No-op (returns a no-op stop) if retention is disabled.
 */
export function startRetention(cfg: AppConfig): () => void {
  if (!cfg.retentionDays || cfg.retentionDays <= 0) {
    log.info('Retention disabled (keeping all clips).');
    return () => {};
  }

  const sweep = () => {
    const deleted = pruneOldClips(cfg.outputDir, cfg.retentionDays, new Date());
    if (deleted.length) {
      log.info(`Retention: deleted ${deleted.length} clip(s) older than ${cfg.retentionDays}d.`);
    }
  };

  sweep(); // run immediately on startup
  const handle = setInterval(sweep, cfg.retentionSweepMinutes * 60 * 1000);
  handle.unref?.(); // don't keep the process alive solely for the sweep timer
  log.info(`Retention: deleting clips older than ${cfg.retentionDays}d, sweeping every ${cfg.retentionSweepMinutes}m.`);

  return () => clearInterval(handle);
}
