import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/connection.js';
import { HttpListingSource } from './listing-source/http-source.js';
import { ListingStub } from './listing-source/stub.js';
import { startLoop, type Loop } from './lib/loop.js';
import { Poller } from './polling/poller.js';
import { OpenAiCompatibleClient } from './summaries/llm-client.js';
import { SummaryWorker } from './summaries/summary-worker.js';

const config = loadConfig();
const db = createDb(config.database);
const stub = config.stub.enabled ? await ListingStub.fromFile(config.stub.fixturesPath) : undefined;
const listingSource = new HttpListingSource(config.listingSource);
const loops: Loop[] = [];
let pollLoop: Loop | undefined;

const app = await buildApp({
  db,
  listingSource,
  stub,
  webDistDir: config.webDistDir,
  onPollRequested: () => pollLoop?.wake(),
  logger: { level: config.logLevel },
});

// Listen before starting the workers: by default the poller fetches from the stub this
// very process serves.
await app.listen({ host: config.host, port: config.port });

if (config.workersEnabled) {
  const pollerLog = app.log.child({ component: 'poller' });
  const poller = new Poller({
    db,
    source: listingSource,
    log: pollerLog,
    intervalSeconds: config.polling.intervalSeconds,
    batchSize: config.polling.batchSize,
    concurrency: config.polling.concurrency,
  });
  pollLoop = startLoop({
    name: 'poller',
    intervalMs: config.polling.tickMs,
    run: () => poller.runOnce(),
    log: pollerLog,
  });

  const summaryLog = app.log.child({ component: 'summaries' });
  const summaries = new SummaryWorker({
    db,
    llm: new OpenAiCompatibleClient(config.llm),
    log: summaryLog,
    batchSize: config.summaries.batchSize,
    concurrency: config.llm.concurrency,
    maxAttempts: config.llm.maxAttempts,
    retryBaseMs: config.summaries.retryBaseMs,
    retryMaxMs: config.summaries.retryMaxMs,
    leaseMs: config.llm.timeoutMs + 30_000,
  });
  loops.push(
    pollLoop,
    startLoop({
      name: 'summaries',
      intervalMs: config.summaries.tickMs,
      run: () => summaries.runOnce(),
      log: summaryLog,
    }),
  );

  app.log.info(
    {
      pollIntervalSeconds: config.polling.intervalSeconds,
      llmBaseUrl: config.llm.baseUrl,
      llmModel: config.llm.model,
    },
    'background workers started',
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // Stop taking new work first, let in-flight polls and LLM calls finish, then close.
  await Promise.all(loops.map((loop) => loop.stop()));
  await app.close();
  await db.destroy();
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
