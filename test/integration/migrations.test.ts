import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connect, ensureSchema, sql } from '../support/db.ts';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];
const FUNCTIONS = [
  'fn_ledger_immutable',
  'fn_ledger_assert_chain',
  'fn_wtx_immutable',
  'fn_wallet_identity_immutable',
  'fn_wallet_balance_has_ledger',
  'fn_outbox_immutable',
];

let owner: MikroORM;

beforeAll(async () => {
  await ensureSchema();
  owner = await connect('owner', 2);
});

afterAll(async () => {
  await ensureSchema(); // deixa o schema aplicado para as demais suítes
  await owner.close();
});

const existing = async (names: string[], catalog: 'tables' | 'functions') => {
  const marks = names.map(() => '?').join(', ');
  const rows =
    catalog === 'tables'
      ? await sql<{ name: string }>(
          owner,
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${marks})`,
          names,
        )
      : await sql<{ name: string }>(
          owner,
          `SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${marks})`,
          names,
        );
  return rows.map((r) => r.name).sort();
};

describe('migrations are reversible', () => {
  test('up → down (all) → up leaves the full schema in place and nothing behind', async () => {
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());

    const reverted = await owner.migrator.down({ to: 0 });
    expect(reverted.map((m) => m.name)).toEqual([
      'Migration20261020000002_integrity_triggers',
      'Migration20261020000001_initial',
    ]);
    expect(await existing(TABLES, 'tables')).toEqual([]);
    expect(await existing(FUNCTIONS, 'functions')).toEqual([]);

    const applied = await owner.migrator.up();
    expect(applied.map((m) => m.name)).toEqual([
      'Migration20261020000001_initial',
      'Migration20261020000002_integrity_triggers',
    ]);
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
  });

  test('the triggers migration alone can be reverted and reapplied', async () => {
    await owner.migrator.down();
    expect(await existing(FUNCTIONS, 'functions')).toEqual([]);
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    await owner.migrator.up();
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
  });

  test('there is nothing pending after up', async () => {
    expect(await owner.migrator.getPending()).toEqual([]);
  });
});
