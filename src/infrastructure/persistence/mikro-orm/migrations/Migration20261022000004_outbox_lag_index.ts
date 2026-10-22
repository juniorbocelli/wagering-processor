import { Migration } from '@mikro-orm/migrations';

/**
 * Índice parcial para a medição de lag da outbox (`outbox_lag_seconds` no endpoint `/metrics`):
 * cobre exclusivamente as mensagens pendentes ordenadas por `occurred_at`.
 * Permite que a query `min(occurred_at) WHERE published_at IS NULL` execute em tempo constante
 * (Index Only Scan), evitando sequential scans e locks sob acúmulo de mensagens.
 */
export class Migration20261022000004_outbox_lag_index extends Migration {
  override up(): void {
    this.addSql(`
      CREATE INDEX ix_outbox_lag ON outbox_messages (occurred_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP INDEX IF EXISTS ix_outbox_lag');
  }
}
