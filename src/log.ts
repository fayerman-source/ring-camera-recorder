/**
 * Minimal leveled logger. Writes a single line per event with an ISO timestamp
 * so output is greppable and friendly to `journalctl`/pm2 log capture.
 */
type Level = 'info' | 'warn' | 'error' | 'debug';

const DEBUG = process.env.RING_DEBUG === '1' || process.env.RING_DEBUG === 'true';

function emit(level: Level, msg: string, extra?: unknown): void {
  if (level === 'debug' && !DEBUG) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} [${level.toUpperCase()}] ${msg}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
};
