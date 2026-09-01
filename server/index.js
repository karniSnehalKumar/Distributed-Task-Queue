const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { pushJob, getJob, getStats, KEYS } = require('./queue');
const redis = require('./redis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/workload', async (req, res) => {
  const {
    count = 10,
    maxDuration = 5000,
    successProbability = 0.9,
    maxAttempts = 3,
  } = req.body;

  if (count > 10000) {
    return res.status(400).json({ error: 'Max 10,000 jobs per workload submission' });
  }

  try {
    const jobPromises = Array.from({ length: count }, () =>
      pushJob({
        duration: Math.floor(Math.random() * maxDuration),
        successProbability,
        maxAttempts,
      })
    );

    await Promise.all(jobPromises);

    console.log(`[API] Ingested workload of ${count} jobs`);

    res.status(201).json({
      submitted: count,
      status: 'queued',
      message: `${count} jobs added to the queue`,
    });
  } catch (err) {
    console.error('[API] Error submitting workload:', err);
    res.status(500).json({ error: 'Failed to submit workload' });
  }
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (err) {
    console.error('[API] Error fetching job:', err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();

    const processing = Math.max(
      0,
      stats.submitted - stats.pending - stats.completed - stats.failed - stats.dead
    );

    const now = Date.now();
    const retrying = await redis.zcount(KEYS.queue, now + 1, '+inf');

    res.json({
      ...stats,
      processing,
      retrying,
      pending: Math.max(0, stats.pending - retrying),
    });
  } catch (err) {
    console.error('[API] Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/workers', async (req, res) => {
  try {
    const workerKeys = await redis.keys('worker:*');

    if (workerKeys.length === 0) {
      return res.json({ workers: [] });
    }

    const workerDataArray = await Promise.all(
      workerKeys.map((key) => redis.hgetall(key))
    );

    const workers = workerDataArray
      .filter((w) => w && w.id)
      .map((w) => ({
        id: w.id,
        containerId: w.containerId || null,
        startedAt: w.startedAt,
        currentJobId: w.currentJobId || null,
        jobsProcessed: parseInt(w.jobsProcessed) || 0,
        status: 'ACTIVE',
      }));

    res.json({ workers });
  } catch (err) {
    console.error('[API] Error fetching workers:', err);
    res.status(500).json({ error: 'Failed to fetch workers' });
  }
});

app.post('/workers/:id/kill', async (req, res) => {
  try {
    const workerData = await redis.hgetall(KEYS.workerHash(req.params.id));

    if (!workerData || !workerData.containerId) {
      return res.status(404).json({ error: 'Worker not found or container ID unavailable' });
    }

    const containerId = workerData.containerId;
    console.log(`[API] Stopping container for worker ${req.params.id} (container: ${containerId})`);

    await redis.del(KEYS.workerHash(req.params.id));

    exec(`docker kill ${containerId}`, (err, stdout, stderr) => {
      if (err) {
        console.error(`[API] docker stop failed for ${containerId}:`, stderr || err.message);
      } else {
        console.log(`[API] Container ${containerId} stopped successfully`);
      }
    });

    res.json({
      killed: true,
      workerId: req.params.id,
      containerId,
      message: 'Worker container stopped. Watchdog will recover any orphaned jobs.',
    });
  } catch (err) {
    console.error('[API] Error killing worker:', err);
    res.status(500).json({ error: 'Failed to kill worker' });
  }
});

app.post('/reset', async (req, res) => {
  try {
    await redis.publish('system:events', JSON.stringify({ type: 'RESET' }));
    await redis.flushdb();

    console.log('[API] Broadcasted RESET event & flushed Redis database');
    res.json({ success: true, message: 'All queues and statistics reset' });
  } catch (err) {
    console.error('[API] Error resetting system:', err);
    res.status(500).json({ error: 'Failed to reset system' });
  }
});

app.listen(PORT, () => {
  console.log(`[API] Server listening on http://localhost:${PORT}`);
  console.log(`[API] Endpoints: POST /workload | GET /stats | GET /workers | POST /reset`);
});
