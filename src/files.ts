import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build a recording filename: {camera}_{ISO8601}.mp4
 *
 * The camera name is slugified so it is always filesystem-safe, and the
 * timestamp uses a colon-free ISO 8601 variant (colons are illegal on some
 * filesystems and awkward in shells). Example:
 *   FrontDoor_2026-06-17T14-03-22Z.mp4
 */
export function clipFilename(cameraName: string, when: Date): string {
  const slug = slugify(cameraName);
  const ts = when.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
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
  } catch {
    return []; // dir not created yet — nothing to prune
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
    } catch {
      // File vanished mid-sweep (e.g. a concurrent record finished/rotated). Skip.
    }
  }
  return deleted;
}
