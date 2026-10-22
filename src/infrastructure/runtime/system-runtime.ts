import type { Clock, IdGenerator } from '../../application/ports/runtime.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7 (ordenável por tempo): bom para índices B-tree e para diagnóstico. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
