import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

export interface AppConfig {
  /** Path to the JSON file holding the Ring refresh token. Created by `npm run auth`. */
  tokenPath: string;
  /** Directory where recorded clips are written. */
  outputDir: string;
  /** Default clip length in seconds for event-triggered and manual recordings. */
  clipLengthSeconds: number;
  /**
   * Camera selection. Either the string "all", or an array of camera names
   * (case-insensitive substring match) / numeric device ids to include.
   */
  cameras: 'all' | Array<string | number>;
  /** Start a recording automatically when a camera reports motion. */
  recordOnMotion: boolean;
  /** Start a recording automatically when a doorbell is pressed (ding). */
  recordOnDing: boolean;
  /**
   * Minimum seconds between two automatic recordings for the SAME camera.
   * Prevents a burst of motion events from spawning overlapping ffmpeg jobs.
   */
  motionCooldownSeconds: number;
  /**
   * Delete clips older than this many days. 0 or null disables retention
   * cleanup (keep everything).
   */
  retentionDays: number | null;
  /** How often (minutes) to run the retention sweep while the service runs. */
  retentionSweepMinutes: number;
}

const DEFAULTS: AppConfig = {
  tokenPath: '.ring-token.json',
  outputDir: 'recordings',
  clipLengthSeconds: 30,
  cameras: 'all',
  recordOnMotion: true,
  recordOnDing: true,
  motionCooldownSeconds: 20,
  retentionDays: null,
  retentionSweepMinutes: 60,
};

/** Resolve a possibly-relative path against the project root. */
export function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(PROJECT_ROOT, p);
}

/**
 * Load config by layering: built-in DEFAULTS < config.json < config.local.json
 * < environment variable overrides. Paths are resolved to absolute.
 */
export function loadConfig(): AppConfig {
  let merged: AppConfig = { ...DEFAULTS };

  for (const name of ['config.json', 'config.local.json']) {
    const file = resolve(PROJECT_ROOT, name);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        merged = { ...merged, ...parsed };
      } catch (err) {
        throw new Error(`Failed to parse ${name}: ${(err as Error).message}`);
      }
    }
  }

  // Environment overrides (handy for systemd unit files / containers).
  if (process.env.RING_TOKEN_PATH) merged.tokenPath = process.env.RING_TOKEN_PATH;
  if (process.env.RING_OUTPUT_DIR) merged.outputDir = process.env.RING_OUTPUT_DIR;
  if (process.env.RING_CLIP_SECONDS) merged.clipLengthSeconds = num(process.env.RING_CLIP_SECONDS, merged.clipLengthSeconds);
  if (process.env.RING_RETENTION_DAYS) {
    // Ignore non-numeric env input rather than silently disabling retention.
    const parsed = Number(process.env.RING_RETENTION_DAYS);
    if (Number.isFinite(parsed)) merged.retentionDays = parsed > 0 ? parsed : null;
  }

  // Resolve paths to absolute so the rest of the app never guesses cwd.
  merged.tokenPath = resolveFromRoot(merged.tokenPath);
  merged.outputDir = resolveFromRoot(merged.outputDir);

  validate(merged);
  return merged;
}

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function validate(c: AppConfig): void {
  if (!Number.isFinite(c.clipLengthSeconds) || c.clipLengthSeconds <= 0)
    throw new Error('clipLengthSeconds must be a number > 0');
  if (!Number.isFinite(c.motionCooldownSeconds) || c.motionCooldownSeconds < 0)
    throw new Error('motionCooldownSeconds must be a number >= 0');
  if (!Number.isFinite(c.retentionSweepMinutes) || c.retentionSweepMinutes <= 0)
    throw new Error('retentionSweepMinutes must be a number > 0');
  if (c.retentionDays !== null && (!Number.isFinite(c.retentionDays) || c.retentionDays < 0))
    throw new Error('retentionDays must be a number >= 0 or null');
  if (c.cameras !== 'all' && !Array.isArray(c.cameras)) {
    throw new Error('cameras must be "all" or an array of names/ids');
  }
}

/** True if a camera (by name + id) is selected by the config filter. */
export function cameraSelected(cfg: AppConfig, name: string, id: number): boolean {
  if (cfg.cameras === 'all') return true;
  return cfg.cameras.some((sel) =>
    typeof sel === 'number' ? sel === id : name.toLowerCase().includes(String(sel).toLowerCase()),
  );
}
