import { createInterface, type Interface } from 'node:readline';
import { RingRestClient } from 'ring-client-api/rest-client';
import { loadConfig } from './config.js';
import { writeToken, tokenFileExists } from './ring.js';
import { log } from './log.js';

/**
 * Interactive one-time login. Prompts for email + password + 2FA code, acquires a
 * refresh token via Ring's auth API, and writes it to the configured token file.
 *
 * The token (not the password) is what the service uses thereafter, and Ring
 * rotates it on every connect — see `onRefreshTokenUpdated` handling in ring.ts.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  if (tokenFileExists(cfg) && !process.argv.includes('--force')) {
    log.warn(`A token already exists at ${cfg.tokenPath}. Re-run with --force to overwrite.`);
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const email = (await question(rl, 'Ring email: ')).trim();
    const password = await hiddenQuestion(rl, 'Ring password: ');

    const client = new RingRestClient({ email, password });

    let ok = false;
    try {
      await client.getAuth();
      ok = true;
    } catch {
      // Expected when 2FA is enabled: the first getAuth triggers the code being
      // sent and sets promptFor2fa with a human-readable instruction.
      if (!client.promptFor2fa) {
        throw new Error('Login failed (check email/password). Ring did not request a 2FA code.');
      }
      log.info(client.promptFor2fa);
      const code = (await question(rl, '2FA code: ')).trim();
      await client.getAuth(code);
      ok = true;
    }

    const token = client.refreshToken;
    if (!ok || !token) throw new Error('Authentication succeeded but no refresh token was returned.');

    writeToken(cfg, token);
    log.info(`Refresh token saved to ${cfg.tokenPath} (mode 0600). You can now run \`npm start\`.`);
  } finally {
    rl.close();
  }
}

function question(rl: Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

/** Prompt without echoing the typed characters (masks with '*'). */
function hiddenQuestion(rl: Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    const iface = rl as Interface & { output: NodeJS.WritableStream; _writeToOutput?: (s: string) => void };
    let muted = false;
    const original = iface._writeToOutput?.bind(iface);
    iface._writeToOutput = (s: string) => {
      if (!muted) {
        iface.output.write(s);
        return;
      }
      // Echo a mask for typed chars but let control sequences (newline) pass.
      iface.output.write(s.includes('\n') ? '\n' : '*');
    };
    rl.question(query, (answer) => {
      iface._writeToOutput = original;
      resolve(answer);
    });
    muted = true;
  });
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
