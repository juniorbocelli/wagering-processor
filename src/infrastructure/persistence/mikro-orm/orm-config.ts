import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261020000001_initial } from './migrations/Migration20261020000001_initial.ts';
import { Migration20261020000002_integrity_triggers } from './migrations/Migration20261020000002_integrity_triggers.ts';
import { Migration20261021000003_retention_indexes } from './migrations/Migration20261021000003_retention_indexes.ts';
import { ALL_SCHEMAS } from './schemas/records.ts';

/** Lista explícita (ADR-005 §4): sem descoberta por glob nem snapshot — igual no Bun, no container e nos testes. */
export const migrationsList = [
  { name: 'Migration20261020000001_initial', class: Migration20261020000001_initial },
  {
    name: 'Migration20261020000002_integrity_triggers',
    class: Migration20261020000002_integrity_triggers,
  },
  { name: 'Migration20261021000003_retention_indexes', class: Migration20261021000003_retention_indexes },
];

export interface OrmConfigOptions {
  clientUrl: string;
  poolMax?: number;
}

/**
 * Configuração única do MikroORM. `allowGlobalContext: false`: qualquer uso do EM global
 * falha; cada requisição/mensagem/ciclo de worker usa um fork. `schema:update` e
 * `synchronize` não existem aqui — o schema é exclusivamente das migrations.
 */
export function buildOrmConfig(options: OrmConfigOptions) {
  return defineConfig({
    clientUrl: options.clientUrl,
    entities: ALL_SCHEMAS,
    allowGlobalContext: false,
    forceUtcTimezone: true,
    extensions: [Migrator],
    pool: { min: 0, max: options.poolMax ?? 10 },
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      snapshot: false,
      allOrNothing: true,
    },
  });
}
