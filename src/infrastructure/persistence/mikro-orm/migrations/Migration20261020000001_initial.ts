import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. Toda regra que o edital (§5.9) exige no banco está aqui como
 * constraint: unicidade, não-negatividade, aritmética do ledger, catálogo de failureCode.
 * Todas as FKs são DEFERRABLE INITIALLY DEFERRED (ADR-002 §2) para que o flush do Unit
 * of Work ordene os INSERTs livremente; os UNIQUE permanecem não diferíveis (alvo de
 * ON CONFLICT e devem falhar no statement).
 */
export class Migration20261020000001_initial extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id             UUID PRIMARY KEY,
        player_id      VARCHAR(128)  NOT NULL CHECK (length(player_id) > 0),
        currency       CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_amount NUMERIC(19,2) NOT NULL CHECK (balance_amount >= 0),
        version        INTEGER       NOT NULL CHECK (version >= 1),
        created_at     TIMESTAMPTZ   NOT NULL,
        updated_at     TIMESTAMPTZ   NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                UUID PRIMARY KEY,
        provider_id                       VARCHAR(64)   NOT NULL,
        external_transaction_id           VARCHAR(128)  NOT NULL,
        idempotency_key                   VARCHAR(255)  NOT NULL,
        payload_hash                      CHAR(64)      NOT NULL,
        payload_hash_version              SMALLINT      NOT NULL DEFAULT 1,
        wallet_id                         UUID          NOT NULL REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        player_id                         VARCHAR(128)  NOT NULL CHECK (length(player_id) > 0),
        round_id                          VARCHAR(128)  NOT NULL,
        game_id                           VARCHAR(128)  NOT NULL,
        kind                              VARCHAR(16)   NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            NUMERIC(19,2) NOT NULL CHECK (amount >= 0),
        currency                          CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id VARCHAR(128)  NULL,
        reference_transaction_id          UUID          NULL REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        status                            VARCHAR(20)   NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      VARCHAR(64)   NULL,
        result_balance_amount             NUMERIC(19,2) NULL,
        reference_attempts                INTEGER       NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         TIMESTAMPTZ   NULL,
        correlation_id                    VARCHAR(128)  NOT NULL,
        created_at                        TIMESTAMPTZ   NOT NULL,
        processed_at                      TIMESTAMPTZ   NULL,
        CONSTRAINT uq_wtx_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wtx_provider_external    UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wtx_amount_positive      CHECK (amount > 0 OR kind = 'LOSS'),
        CONSTRAINT ck_wtx_reference_required   CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wtx_failure_code         CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wtx_failure_code_catalog CHECK (failure_code IS NULL OR failure_code IN (
          'WALLET_PLAYER_MISMATCH','CURRENCY_MISMATCH','REFERENCE_SCOPE_MISMATCH','REFERENCE_KIND_NOT_ALLOWED',
          'REFERENCE_NOT_PROCESSED','REFERENCE_ALREADY_REVERSED','AMOUNT_MISMATCH','INSUFFICIENT_FUNDS',
          'REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_NOT_FOUND','PROCESSING_FAILED')),
        CONSTRAINT ck_wtx_processed_at         CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wtx_result_balance_nonneg CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
        CONSTRAINT ck_wtx_processed_has_result CHECK (status <> 'PROCESSED' OR result_balance_amount IS NOT NULL),
        CONSTRAINT ck_wtx_reversal_resolved    CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)
      )`);
    this.addSql(`
      CREATE UNIQUE INDEX uq_wtx_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(
      `CREATE UNIQUE INDEX uq_wtx_single_opening ON wager_transactions (wallet_id) WHERE kind = 'OPENING'`,
    );
    this.addSql(`
      CREATE INDEX ix_wtx_pending_reference ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX ix_wtx_reference_lookup ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             UUID PRIMARY KEY,
        wallet_id      UUID          NOT NULL,
        currency       CHAR(3)       NOT NULL,
        transaction_id UUID          NOT NULL REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        direction      VARCHAR(6)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         NUMERIC(19,2) NOT NULL CHECK (amount > 0),
        balance_before NUMERIC(19,2) NOT NULL CHECK (balance_before >= 0),
        balance_after  NUMERIC(19,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version INTEGER       NOT NULL CHECK (wallet_version >= 1),
        created_at     TIMESTAMPTZ   NOT NULL,
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT uq_ledger_transaction     UNIQUE (transaction_id),
        CONSTRAINT uq_ledger_wallet_version  UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      )`);

    // ADR-004 §2: a existência da linha significa "processada" (mesma transação do efeito).
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(64)  NOT NULL,
        message_id    VARCHAR(128) NOT NULL,
        payload_hash  CHAR(64)     NOT NULL,
        received_at   TIMESTAMPTZ  NOT NULL,
        processed_at  TIMESTAMPTZ  NOT NULL,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    // ADR-004 §4
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              UUID PRIMARY KEY,
        seq             BIGINT       GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id    UUID         NOT NULL,
        event_type      VARCHAR(64)  NOT NULL,
        event_version   SMALLINT     NOT NULL,
        payload         JSONB        NOT NULL,
        occurred_at     TIMESTAMPTZ  NOT NULL,
        attempts        INTEGER      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ  NOT NULL,
        locked_until    TIMESTAMPTZ  NULL,
        locked_by       VARCHAR(128) NULL,
        published_at    TIMESTAMPTZ  NULL,
        last_error      VARCHAR(512) NULL
      )`);
    this.addSql(`
      CREATE INDEX ix_outbox_pending_by_aggregate ON outbox_messages (aggregate_id, seq)
        WHERE published_at IS NULL`);
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
