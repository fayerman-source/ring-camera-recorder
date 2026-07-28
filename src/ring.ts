import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { RingApi, type RingCamera } from 'ring-client-api';
import type { AppConfig } from './config.js';
import { cameraSelected } from './config.js';
import { log } from './log.js';

interface TokenFile {
  refreshToken: string;
  /** ISO timestamp of the last time we wrote this file — informational only. */
  updatedAt?: string;
}

export function tokenFileExists(cfg: AppConfig): boolean {
  return existsSync(cfg.tokenPath);
}

export function readToken(cfg: AppConfig): string {
  if (!existsSync(cfg.tokenPath)) {
    throw new Error(
      `No refresh token at ${cfg.tokenPath}. Run \`npm run auth\` first to log in.`,
    );
  }
  let raw: TokenFile;
  try {
    raw = JSON.parse(readFileSync(cfg.tokenPath, 'utf8')) as TokenFile;
  } catch (err) {
    throw new Error(
      `Token file ${cfg.tokenPath} is unreadable or not valid JSON (${(err as Error).message}). Re-run \`npm run auth\`.`,
    );
  }
  if (!raw?.refreshToken) {
    throw new Error(`Token file ${cfg.tokenPath} is missing "refreshToken". Re-run \`npm run auth\`.`);
  }
  return raw.refreshToken;
}

/** Write the token with 0600 perms (it grants full account access). */
export function writeToken(cfg: AppConfig, refreshToken: string): void {
  const body: TokenFile = { refreshToken, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(cfg.tokenPath), { recursive: true });
  // Write to a temp file then atomically rename, so an interruption (or a
  // concurrent rotation) can't leave a truncated, unparseable token file that
  // would break the next startup.
  const tmp = `${cfg.tokenPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, cfg.tokenPath);
  try {
    chmodSync(cfg.tokenPath, 0o600); // enforce perms even if the file pre-existed
  } catch {
    /* best effort on filesystems without unix perms */
  }
}

/**
 * Construct a RingApi from the stored token and wire up rotation persistence.
 *
 * Ring rotates refresh tokens continuously and expires the old one shortly after
 * use, so an unattended service MUST persist every rotation — otherwise it works
 * once and then fails to re-auth on the next restart. That is what
 * `onRefreshTokenUpdated` is for.
 */
export function createRingApi(cfg: AppConfig): RingApi {
  const refreshToken = readToken(cfg);

  const api = new RingApi({
    refreshToken,
    // Poll camera status so battery/online changes are reflected; cheap.
    cameraStatusPollingSeconds: 20,
    // ffmpeg: bundled ffmpeg-for-homebridge by default. Override via RING_FFMPEG.
    ...(process.env.RING_FFMPEG ? { ffmpegPath: process.env.RING_FFMPEG } : {}),
    debug: process.env.RING_DEBUG === '1' || process.env.RING_DEBUG === 'true',
  });

  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken, oldRefreshToken }) => {
    if (!oldRefreshToken) return; // initial emit on first connect — nothing to replace yet
    log.info('Ring refresh token rotated; persisting new token.');
    writeToken(cfg, newRefreshToken);
  });

  return api;
}

/** Render cameras as `Name (#id), Other (#id)` for error and warning messages. */
export function formatCameraList(cameras: readonly Pick<RingCamera, 'name' | 'id'>[]): string {
  if (cameras.length === 0) return '(none)';
  return cameras.map((c) => `${c.name} (#${c.id})`).join(', ');
}

/** Get cameras filtered by the config `cameras` selector. */
export async function getSelectedCameras(api: RingApi, cfg: AppConfig): Promise<RingCamera[]> {
  const all = await api.getCameras();
  const selected = all.filter((c) => cameraSelected(cfg, c.name, c.id));
  if (selected.length === 0) {
    log.warn(
      `No cameras matched the config filter ${JSON.stringify(cfg.cameras)}. ` +
        `Found: ${formatCameraList(all)}`,
    );
  }
  return selected;
}
