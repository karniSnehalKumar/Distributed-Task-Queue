const redis = require('./redis');
const { v4: uuidv4 } = require('uuid');

const KEYS = {
  jobHash: (id) => `job:${id}`,
  queue: 'queue:pending',
  deadQueue: 'queue:dead',
  processing: (id) => `processing:${id}`,
  workerHash: (id) => `worker:${id}`,
  inflight: 'jobs:inflight',
  stats: {
    submitted: 'stats:submitted',
    completed: 'stats:completed',
    failed: 'stats:failed',
    dead: 'stats:dead',
  },
};

const BASE_DELAY_MS = 1000;

async function pushJob({ duration, successProbability, maxAttempts = 3, processAfter = null }) {
  const id = uuidv4();
  const now = Date.now();
  const scheduledTime = processAfter || now;

  const job = {
    id,
    status: 'QUEUED',
    duration,
    successProbability,
    attempts: 0,
    maxAttempts,
    createdAt: now,
    processAfter: scheduledTime,
    startedAt: '',
    completedAt: '',
    workerId: '',
    result: '',
    error: '',
  };

  await redis.hset(KEYS.jobHash(id), job);
  await redis.zadd(KEYS.queue, scheduledTime, id);
  await redis.incr(KEYS.stats.submitted);
}

async function popJob() {
  const now = Date.now();

  const readyJobs = await redis.zrangebyscore(KEYS.queue, 0, now, 'LIMIT', 0, 1);

  if (readyJobs.length === 0) {
    return null;
  }

  const result = await redis.zpopmin(KEYS.queue, 1);

  if (!result || result.length === 0) {
    return null;
  }

  const jobId = result[0];
  const score = parseFloat(result[1]);

  if (score > now) {
    await redis.zadd(KEYS.queue, score, jobId);
    return null;
  }

  const job = await redis.hgetall(KEYS.jobHash(jobId));

  if (!job || !job.id) {
    return null;
  }

  return job;
}

async function updateJob(jobId, fields) {
  await redis.hset(KEYS.jobHash(jobId), fields);
}

async function getJob(jobId) {
  const job = await redis.hgetall(KEYS.jobHash(jobId));
  if (!job || !job.id) return null;
  return job;
}

async function requeueWithBackoff(jobId, attempts) {
  const delay = BASE_DELAY_MS * Math.pow(2, attempts - 1);
  const processAfter = Date.now() + delay;

  await updateJob(jobId, {
    status: 'RETRYING',
    processAfter,
  });

  await redis.zadd(KEYS.queue, processAfter, jobId);

  console.log(`[Queue] Job ${jobId} requeued. Scheduled retry in ${delay}ms (Attempt ${attempts})`);
}

async function moveToDeadQueue(jobId) {
  await updateJob(jobId, { status: 'DEAD' });
  await redis.rpush(KEYS.deadQueue, jobId);
  await redis.incr(KEYS.stats.dead);
  console.log(`[Queue] Job ${jobId} exhausted all retries → moved to Dead-Letter Queue`);
}

async function getStats() {
  const [submitted, completed, failed, dead, pendingCount] = await Promise.all([
    redis.get(KEYS.stats.submitted),
    redis.get(KEYS.stats.completed),
    redis.get(KEYS.stats.failed),
    redis.get(KEYS.stats.dead),
    redis.zcard(KEYS.queue),
  ]);

  return {
    submitted: parseInt(submitted) || 0,
    completed: parseInt(completed) || 0,
    failed: parseInt(failed) || 0,
    dead: parseInt(dead) || 0,
    pending: pendingCount || 0,
  };
}

async function addToInflight(jobId) {
  await redis.sadd(KEYS.inflight, jobId);
}

async function removeFromInflight(jobId) {
  await redis.srem(KEYS.inflight, jobId);
}

async function getAllInflight() {
  return redis.smembers(KEYS.inflight);
}

module.exports = {
  pushJob,
  popJob,
  updateJob,
  getJob,
  requeueWithBackoff,
  moveToDeadQueue,
  getStats,
  addToInflight,
  removeFromInflight,
  getAllInflight,
  KEYS,
};
