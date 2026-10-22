import { Migration } from '@mikro-orm/migrations';

/**
 * Índices parciais para o expurgo de inbox/outbox (ADR-011): cobrem **apenas** linhas
 * elegíveis (outbox publicada; toda linha de inbox é "processada"), de modo que o worker
 * de retenção ordena por data sem varrer a tabela e a outbox pendente continua servida
 * só pelos índices do publisher.
 */
export class Migration20261021000003_retention_indexes extends Migration {
  override up(): void {
    this.addSql(`
      CREATE INDEX ix_outbox_published ON outbox_messages (published_at)
        WHERE published_at IS NOT NULL`);
    this.addSql('CREATE INDEX ix_inbox_processed ON inbox_messages (processed_at)');
  }

  override down(): void {
    this.addSql('DROP INDEX IF EXISTS ix_inbox_processed');
    this.addSql('DROP INDEX IF EXISTS ix_outbox_published');
  }
}
