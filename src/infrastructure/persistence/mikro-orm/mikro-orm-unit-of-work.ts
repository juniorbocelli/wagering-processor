import { AsyncLocalStorage } from 'node:async_hooks';
import { LockMode, IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../../application/ports/persistence.ts';
import { mapDriverError } from './driver-errors.ts';

/**
 * Contexto do `EntityManager` transacional corrente (AsyncLocalStorage). Com
 * `allowGlobalContext: false` o EM global nunca é usado diretamente: cada unidade de
 * trabalho roda num `fork` com Identity Map próprio (ADR-005 §3).
 */
export class EntityManagerContext {
  private readonly storage = new AsyncLocalStorage<EntityManager>();

  constructor(private readonly orm: MikroORM) {}

  inTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** EM da transação em curso; fora dela, um fork novo (leitura avulsa, sem lock). */
  current(): EntityManager {
    return this.storage.getStore() ?? this.orm.em.fork();
  }

  /** EM da transação em curso; falha se chamado fora de `UnitOfWork.run` (ex.: `FOR UPDATE`). */
  requireTransactional(): EntityManager {
    const em = this.storage.getStore();
    if (em === undefined) {
      throw new Error('This operation requires an active UnitOfWork transaction');
    }
    return em;
  }

  run<T>(em: EntityManager, work: () => Promise<T>): Promise<T> {
    return this.storage.run(em, work);
  }
}

export interface UnitOfWorkOptions {
  lockTimeout: string;
  statementTimeout: string;
}

const DEFAULT_OPTIONS: UnitOfWorkOptions = { lockTimeout: '3s', statementTimeout: '5s' };
const DURATION_PATTERN = /^\d{1,6}(ms|s|min)$/;

/**
 * `UnitOfWork` sobre `em.fork().transactional()`: `READ COMMITTED`, com `lock_timeout` e
 * `statement_timeout` aplicados via `SET LOCAL` — apenas nas transações financeiras
 * (ADR-002 §3). Chamadas aninhadas reaproveitam a transação corrente.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly context: EntityManagerContext,
    private readonly options: UnitOfWorkOptions = DEFAULT_OPTIONS,
  ) {
    for (const value of [options.lockTimeout, options.statementTimeout]) {
      if (!DURATION_PATTERN.test(value)) {
        throw new Error(`Invalid PostgreSQL duration: "${value}"`);
      }
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.inTransaction()) {
      return work();
    }
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // set_config(..., true) equivale a SET LOCAL (parametrizável). O modificador `is_local = true`
          // restringe o timeout estritamente à transação corrente, evitando que conexões
          // devolvidas ao pool do PostgreSQL contaminem operações subsequentes com timeouts residuais.
          await em.execute(
            `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
            [this.options.lockTimeout, this.options.statementTimeout],
          );
          return this.context.run(em, work);
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw mapDriverError(error);
    }
  }
}

export { LockMode };
