import { buildOrmConfig } from './src/infrastructure/persistence/mikro-orm/orm-config.ts';

/**
 * Configuração das migrations: conecta como `wagering_owner` (dono do schema), nunca
 * como o papel de runtime. Consumida por `scripts/migrate.ts`.
 */
export default buildOrmConfig({
  clientUrl:
    process.env['MIGRATION_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgres://wagering_owner:wagering_owner@localhost:5432/wagering',
  poolMax: 2,
});
