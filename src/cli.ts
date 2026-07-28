import type { RingApi } from 'ring-client-api';
import { loadConfig, type AppConfig } from './config.js';
import { createRingApi, formatCameraList } from './ring.js';
import { recordClip } from './recorder.js';
import { log } from './log.js';

/**
 * Small CLI:
 *   ring-recorder list
 *   ring-recorder record --camera "Front Door" --seconds 30
 */
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command !== 'list' && command !== 'record') {
    log.error('Usage: ring-recorder <list | record --camera "Name" --seconds 30>');
    process.exit(2);
  }

  const cfg = loadConfig();
  const api = createRingApi(cfg); // reads token; throws a friendly error if missing

  try {
    if (command === 'list') {
      await runList(api);
    } else {
      await runRecord(api, cfg, rest);
    }
  } finally {
    api.disconnect();
    // ffmpeg/WebRTC teardown can leave handles open briefly; exit cleanly.
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  }
}

async function runList(api: RingApi): Promise<void> {
  const cameras = await api.getCameras();
  if (cameras.length === 0) {
    log.warn('No cameras found on this account.');
    return;
  }
  log.info(`Found ${cameras.length} camera(s):`);
  for (const c of cameras) {
    const kind = c.isDoorbot ? 'doorbell' : 'camera';
    const battery = c.batteryLevel != null ? `${c.batteryLevel}%` : 'wired';
    process.stdout.write(`  #${c.id}  ${c.name}  [${kind}, ${c.model}, battery: ${battery}]\n`);
  }
}

async function runRecord(api: RingApi, cfg: AppConfig, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const seconds = args.seconds ? Number(args.seconds) : cfg.clipLengthSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be a positive number');

  const cameras = await api.getCameras();
  const match = pickCamera(cameras, args.camera);
  if (!match) {
    const requested = args.camera ? `"${args.camera}"` : '(none specified)';
    throw new Error(
      `No camera matched ${requested}. Available: ${formatCameraList(cameras)}`,
    );
  }
  const result = await recordClip(match, cfg, seconds);
  log.info(`Done: ${result.path}`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function pickCamera(cameras: Awaited<ReturnType<ReturnType<typeof createRingApi>['getCameras']>>, sel?: string) {
  if (!sel) return cameras[0]; // default to the first camera if unspecified
  const byId = Number(sel);
  if (Number.isFinite(byId)) {
    const hit = cameras.find((c) => c.id === byId);
    if (hit) return hit;
  }
  return cameras.find((c) => c.name.toLowerCase().includes(sel.toLowerCase()));
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
