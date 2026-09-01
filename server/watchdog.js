const redis = require('./redis');
const {
  getAllInflight,
  removeFromInflight,
  updateJob,
  getJob,
  KEYS,
} = require('./queue');

const CHECK_INTERVAL_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recoverJob(jobId) {
  const job = await getJob(jobId);

  if (!job) {
    await removeFromInflight(jobId);
    console.log(`[Watchdog] Job ${jobId} not found in Redis, removing from inflight`);
    return;
  }

  if (job.status !== 'PROCESSING') {
    await removeFromInflight(jobId);
    console.log(`[Watchdog] Job ${jobId} already transitioned to ${job.status}, skipping recovery`);
    return;
  }

  console.log(`[Watchdog] ⚠ Orphaned job detected: ${jobId} (was claimed by ${job.workerId || 'unknown'})`);

  const now = Date.now();

  await updateJob(jobId, {
    status: 'QUEUED',
    workerId: '',
    startedAt: '',
    processAfter: now,
    error: `Recovered by Watchdog — previous worker (${job.workerId}) crashed`,
  });

  await redis.zadd(KEYS.queue, now, jobId);
  await removeFromInflight(jobId);

  console.log(`[Watchdog] ✓ Job ${jobId} re-queued for recovery`);
}

async function runCheck() {
  const inflightIds = await getAllInflight();

  if (inflightIds.length === 0) {
    return;
  }

  for (const jobId of inflightIds) {
    const heartbeatExists = await redis.exists(KEYS.processing(jobId));

    if (heartbeatExists === 0) {
      await recoverJob(jobId);
    }
  }
}

let running = true;

async function runWatchdog() {
  console.log(`[Watchdog] Supervisor started — scanning for orphaned jobs every ${CHECK_INTERVAL_MS / 1000}s`);

  while (running) {
    try {
      await runCheck();
    } catch (err) {
      console.error('[Watchdog] Error during recovery check:', err.message);
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

process.on('SIGINT', async () => {
  console.log('\n[Watchdog] Shutting down supervisor cleanly...');
  running = false;
  await redis.quit();
  process.exit(0);
});

runWatchdog().catch((err) => {
  console.error('[Watchdog] Fatal error:', err);
  process.exit(1);
});
