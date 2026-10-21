/**
 * Executa as migrations como `wagering_owner`.
 *
 *   bun scripts/migrate.ts up        # aplica todas as pendentes
 *   bun scripts/migrate.ts down      # reverte a última
 *   bun scripts/migrate.ts reset     # reverte todas
 *   bun scripts/migrate.ts status    # lista as pendentes
 */
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.ts';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(config);

try {
  const migrator = orm.migrator;
  if (command === 'up') {
    const done = await migrator.up();
    console.log(`migrations applied: ${done.map((m) => m.name).join(', ') || 'none'}`);
  } else if (command === 'down') {
    const done = await migrator.down();
    console.log(`migrations reverted: ${done.map((m) => m.name).join(', ') || 'none'}`);
  } else if (command === 'reset') {
    const done = await migrator.down({ to: 0 });
    console.log(`migrations reverted: ${done.map((m) => m.name).join(', ') || 'none'}`);
  } else if (command === 'status') {
    const pending = await migrator.getPending();
    console.log(`pending migrations: ${pending.map((m) => m.name).join(', ') || 'none'}`);
  } else {
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
  }
} finally {
  await orm.close();
}
