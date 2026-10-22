/** Espera ativa até `predicate` ser verdadeiro (ou lança com `message` ao estourar o prazo). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 15_000, intervalMs = 50, message = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
    await sleep(intervalMs);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
