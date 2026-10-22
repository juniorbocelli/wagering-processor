import { describe, expect, test } from 'bun:test';
import { TEST_URLS, ensureSchema } from '../support/db.ts';
import { waitFor } from '../support/wait.ts';

/** Sobe `src/main.ts` como processo real (a mesma entrada da imagem Docker). */
function spawnService(port: number) { // check-money:allow
  return Bun.spawn(['bun', 'src/main.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      DATABASE_URL: TEST_URLS.app,
      PORT: String(port),
      AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function ready(port: number): Promise<boolean> { // check-money:allow
  try {
    return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200;
  } catch {
    return false;
  }
}

describe('service process (main.ts)', () => {
  test('boots, serves HTTP and exits 0 with a graceful shutdown on SIGTERM', async () => {
    await ensureSchema();
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const proc = spawnService(port);
    try {
      await waitFor(() => ready(port), { timeoutMs: 30_000, message: 'the service to be ready' });
      const created = await fetch(`http://127.0.0.1:${port}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: `p-${crypto.randomUUID()}`, initialBalance: { amount: '5.00', currency: 'BRL' } }),
      });
      expect(created.status).toBe(201);

      proc.kill('SIGTERM');
      expect(await proc.exited).toBe(0);
      const output = await new Response(proc.stdout).text();
      expect(output).toContain('shutdown requested');
      expect(output).toContain('shutdown complete');
    } finally {
      proc.kill('SIGKILL');
    }
  }, 60_000);
});
