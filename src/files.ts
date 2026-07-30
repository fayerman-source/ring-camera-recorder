import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

/**
 * Build a recording filename: {camera}_{ISO8601}.mp4
 *
 * The camera name is slugified so it is always filesystem-safe, and the
 * timestamp uses a colon-free ISO 8601 variant (colons are illegal on some
 * filesystems and awkward in shells). Milliseconds are kept so two recordings
 * of the same camera started within the same second don't collide and overwrite
 * each other. Example:
 *   FrontDoor_2026-06-17T14-03-22-500Z.mp4
 */
export function clipFilename(cameraName: string, when: Date): string {
  const slug = slugify(cameraName);
  const ts = when.toISOString().replace(/[:.]/g, '-');
  return `${slug}_${ts}.mp4`;
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-') || 'camera'
  );
}

/** Ensure the output directory exists; returns the absolute path passed in. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Append one JSON object as a line to `file`.
 *
 * Returns false instead of throwing: this is diagnostic bookkeeping attached to
 * a recording that already succeeded, so a full disk or a permissions problem
 * must never turn a saved clip into a reported failure.
 */
export function appendJsonLine(file: string, record: unknown): boolean {
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    log.warn(`Could not append to ${file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Delete .mp4 files in `dir` whose mtime is older than `retentionDays`.
 * Returns the list of deleted file paths. A null/0 retention is a no-op.
 */
export function pruneOldClips(dir: string, retentionDays: number | null, now: Date): string[] {
  if (!retentionDays || retentionDays <= 0) return [];
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // Output dir not created yet is fine; surface real failures (permissions,
    // I/O) instead of silently disabling retention.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.mp4')) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        unlinkSync(full);
        deleted.push(full);
      }
    } catch (err) {
      // A file vanishing mid-sweep (ENOENT) is expected; surface anything else
      // (permissions, I/O) so expired clips aren't silently left in place.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Retention: could not process ${full}: ${(err as Error).message}`);
      }
    }
  }
  return deleted;
}
