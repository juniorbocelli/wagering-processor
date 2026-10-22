import { MikroORM } from '@mikro-orm/postgresql';
import { createLogger } from './infrastructure/observability/logger.ts';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics.ts';
import { PostgresHealthProbe, SqsHealthProbe } from './infrastructure/observability/health-probes.ts';
import { TrustedPayloadProviderIdentity } from './infrastructure/auth/trusted-payload-provider-identity.ts';
import { faultInjectorFromEnv } from './infrastructure/fault-injection.ts';
import { createSqsClient } from './infrastructure/messaging/sqs/sqs.ts';
import { UuidV7Generator } from './infrastructure/runtime/system-runtime.ts';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm/orm-config.ts';
import { buildWageringServices } from './infrastructure/wagering-services.ts';
import { createHttpApp } from './interfaces/http/create-app.ts';
import {
  DEFAULT_PERIODIC_RECONCILIATION_OPTIONS,
  PeriodicReconciliationWorker,
} from './interfaces/workers/periodic-reconciliation-worker.ts';
import { buildMessagingRuntime, intFromEnv, loadMessagingConfig } from './messaging-runtime.ts';

/**
 * Raiz de composição do processo: HTTP + consumidor SQS + workers numa mesma instância
 * (qualquer número de instâncias pode rodar em paralelo; a coordenação é do PostgreSQL).
 * `SIGTERM`/`SIGINT`: para de aceitar HTTP, conclui ou devolve as mensagens em voo, para os
 * workers e só então fecha o pool.
 */
async function main(): Promise<void> {
  const env = process.env;
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');

  const logger = createLogger();
  const metrics = new PrometheusMetrics();
  const faults = faultInjectorFromEnv(env);
  const messagingConfig = loadMessagingConfig(env);

  const orm = await MikroORM.init(buildOrmConfig({ clientUrl: databaseUrl, poolMax: intFromEnv(env, 'DB_POOL_MAX', 20) }));
  const services = buildWageringServices(orm, { metrics, faults, logger });
  const sqs = createSqsClient(env);
  const messaging = await buildMessagingRuntime({ services, config: messagingConfig, sqs, logger, faults });
  const reconciliation = new PeriodicReconciliationWorker({
    useCase: services.reconcileAllWallets,
    options: {
      intervalMs: intFromEnv(env, 'RECONCILIATION_INTERVAL_MS', DEFAULT_PERIODIC_RECONCILIATION_OPTIONS.intervalMs),
    },
    logger,
  });

  const app = await createHttpApp({
    openWallet: services.openWallet,
    processWagerTransaction: services.processWagerTransaction,
    getWallet: services.getWallet,
    listLedger: services.listLedger,
    getTransaction: services.getTransaction,
    reconcileWallet: services.reconcileWallet,
    identity: new TrustedPayloadProviderIdentity(),
    readiness: [new PostgresHealthProbe(orm), new SqsHealthProbe(sqs, messagingConfig.wagerQueueName)],
    metrics,
    logger,
    ids: new UuidV7Generator(),
  });

  messaging.start();
  reconciliation.start();
  const port = intFromEnv(env, 'PORT', 3000);
  await app.listen(port, '0.0.0.0');
  logger.info('wagering service started', { port });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown requested', { signal });
    const forced = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, (messagingConfig.consumer.gracePeriodMs ?? 20_000) + 10_000);
    forced.unref();
    try {
      await app.close();
      await messaging.stop();
      await reconciliation.stop();
      await orm.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('fatal: could not start the wagering service', error);
  process.exit(1);
});
