const { v4: uuidv4 } = require('uuid');
const redis = require('./redis');
const {
  popJob,
  updateJob,
  requeueWithBackoff,
  moveToDeadQueue,
  addToInflight,
  removeFromInflight,
  KEYS,
} = require('./queue');

const WORKER_ID = `worker-${uuidv4().slice(0, 8)}`;

const POLL_INTERVAL_MS = 500;
const HEARTBEAT_TTL_S = 15;
const HEARTBEAT_RENEW_INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workerRegistrationInterval;
let jobsProcessed = 0;

const subClient = redis.duplicate();
subClient.subscribe('system:events').catch((err) =>
  console.error(`[${WORKER_ID}] Pub/Sub error:`, err)
);

subClient.on('message', (channel, msg) => {
  try {
    const event = JSON.parse(msg);
    if (event.type === 'RESET') {
      jobsProcessed = 0;
      console.log(`[${WORKER_ID}] 🔄 Received system RESET broadcast — local jobs counter zeroed`);

      redis.hset(KEYS.workerHash(WORKER_ID), {
        id: WORKER_ID,
        pid: process.pid,
        jobsProcessed: 0,
        currentJobId: '',
      }).catch(() => {});
    }
  } catch (err) {
    // Ignore parse errors on unexpected message formats
  }
});

async function registerWorker() {
  await redis.hset(KEYS.workerHash(WORKER_ID), {
    id: WORKER_ID,
    containerId: process.env.HOSTNAME || 'local',
    startedAt: Date.now(),
    currentJobId: '',
    jobsProcessed: 0,
  });

  await redis.expire(KEYS.workerHash(WORKER_ID), 12);

  workerRegistrationInterval = setInterval(async () => {
    const keyExists = await redis.exists(KEYS.workerHash(WORKER_ID));
    if (!keyExists) {
      jobsProcessed = 0;
    }

    await redis.hset(KEYS.workerHash(WORKER_ID), {
      id: WORKER_ID,
      containerId: process.env.HOSTNAME || 'local',
      jobsProcessed,
    });
    await redis.expire(KEYS.workerHash(WORKER_ID), 12);
  }, 5000);

  console.log(`[${WORKER_ID}] Worker registered (container: ${process.env.HOSTNAME || 'local'})`);
}

function startHeartbeat(jobId) {
  redis.set(KEYS.processing(jobId), WORKER_ID, 'EX', HEARTBEAT_TTL_S);

  const interval = setInterval(() => {
    redis.set(KEYS.processing(jobId), WORKER_ID, 'EX', HEARTBEAT_TTL_S);
  }, HEARTBEAT_RENEW_INTERVAL_MS);

  return function stopHeartbeat() {
    clearInterval(interval);
    redis.del(KEYS.processing(jobId));
  };
}

async function processJob(job) {
  const jobId = job.id;
  const attempts = parseInt(job.attempts) + 1;
  const maxAttempts = parseInt(job.maxAttempts);
  const duration = parseInt(job.duration);
  const successProbability = parseFloat(job.successProbability);

  console.log(`[${WORKER_ID}] Starting job ${jobId} | Attempt ${attempts}/${maxAttempts} | Duration ${duration}ms`);

  await updateJob(jobId, {
    status: 'PROCESSING',
    attempts,
    workerId: WORKER_ID,
    startedAt: Date.now(),
  });

  await addToInflight(jobId);
  await redis.hset(KEYS.workerHash(WORKER_ID), { currentJobId: jobId });

  const stopHeartbeat = startHeartbeat(jobId);

  try {
    await sleep(duration);

    const jobExists = await redis.exists(KEYS.jobHash(jobId));
    if (!jobExists) {
      console.log(`[${WORKER_ID}] Job ${jobId} was cleared during reset — discarding result`);
      return;
    }

    const succeeded = Math.random() < successProbability;

    if (succeeded) {
      await updateJob(jobId, {
        status: 'COMPLETED',
        completedAt: Date.now(),
        result: `Completed by ${WORKER_ID} in ${duration}ms`,
        error: '',
      });

      await redis.incr(KEYS.stats.completed);
      jobsProcessed++;
      console.log(`[${WORKER_ID}] ✓ Job ${jobId} COMPLETED`);

    } else {
      console.log(`[${WORKER_ID}] ✗ Job ${jobId} FAILED (Attempt ${attempts}/${maxAttempts})`);

      await updateJob(jobId, {
        error: `Failed on attempt ${attempts}`,
      });

      await redis.incr(KEYS.stats.failed);

      if (attempts < maxAttempts) {
        await requeueWithBackoff(jobId, attempts);
      } else {
        await moveToDeadQueue(jobId);
      }
    }

  } finally {
    stopHeartbeat();
    await removeFromInflight(jobId);
    await redis.hset(KEYS.workerHash(WORKER_ID), { currentJobId: '' });
  }
}

let running = true;

async function runWorker() {
  await registerWorker();
  console.log(`[${WORKER_ID}] Polling for jobs every ${POLL_INTERVAL_MS}ms...`);

  while (running) {
    try {
      const job = await popJob();

      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await processJob(job);

    } catch (err) {
      console.error(`[${WORKER_ID}] Unexpected error in poll loop:`, err.message);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

process.on('SIGINT', async () => {
  console.log(`\n[${WORKER_ID}] Shutting down gracefully...`);
  running = false;
  clearInterval(workerRegistrationInterval);
  await subClient.quit().catch(() => {});
  await redis.del(KEYS.workerHash(WORKER_ID));
  await redis.quit();
  process.exit(0);
});

runWorker().catch((err) => {
  console.error(`[${WORKER_ID}] Fatal error:`, err);
  process.exit(1);
});
