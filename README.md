# ⚡ Distributed Task Queue (from scratch)

A lightweight, observable, and fault-tolerant **distributed background task queue** built from scratch using **Node.js, Express, Redis, and React**.

> 💡 Built without external queue abstractions (No BullMQ, No Celery, No Bee-Queue) to demonstrate core distributed systems concepts: atomic job consumption, horizontal worker scaling, exponential backoff retries, heartbeat leases, and automatic crash recovery.

---

## 🏗️ High-Level Architecture

```text
                     React Observability Dashboard
                     (Live status, metric graphs, logs)
                                  |
                                  | HTTP Polling (2s) / REST Actions
                                  v
                        Express API (Producer)
                     (POST /workload, GET /stats, /workers)
                                  |
                                  | Atomic ZADD / HSET
                                  v
                            Redis Store
        +-------------------------+-------------------------+
        |                         |                         |
  queue:pending            jobs:inflight               job:<jobId>
  (Sorted Set by time)     (Set of active IDs)        (Hash of job metadata)
        |                         |                         |
        +------------+------------+                         |
                     |                                      |
                     | Atomic ZPOPMIN                       |
                     v                                      |
          +----------+----------+                           |
          |          |          |                           |
          v          v          v                           |
       Worker 1   Worker 2   Worker 3                       |
       (Process)  (Process)  (Process) ---------------------+
          |          |          |    Heartbeat Key (TTL=15s)
          +----------+----------+
                     ^
                     | Auto-Requeue orphaned jobs on lease expiry
             Watchdog Process
        (Heartbeat monitor & recovery)
```

---

## 🧠 Key Technical Problems & Solutions

### 1. Atomic Job Claiming (Preventing Race Conditions)
* **Problem**: When multiple workers poll simultaneously, two workers could select and process the exact same job.
* **Solution**: `ZPOPMIN` on the Redis Sorted Set. It reads and removes the job with the earliest timestamp in **one single atomic operation**. No two workers can ever claim the same job.

### 2. Worker Crash Recovery (Heartbeat & Lease Pattern)
* **Problem**: If a worker process crashes (`kill -9`, OOM, network partition) while processing a job, the job would remain trapped in `PROCESSING` status forever.
* **Solution**: 
  1. Worker claims job $\to$ registers `processing:<jobId>` with a 15-second TTL in Redis and tracks the ID in `jobs:inflight`.
  2. Worker continuously renews the TTL every 5s while alive.
  3. A standalone **Watchdog process** scans `jobs:inflight` every 8s. If the TTL key has expired, the watchdog detects an orphaned job and atomically re-queues it back to `queue:pending`.

### 3. Exponential Backoff Retries
* **Problem**: Retrying failed jobs immediately overwhelms downstream services and causes thundering herd problems.
* **Solution**: Failed jobs calculate delay:
  $$\text{delay} = \text{BASE\_DELAY} \times 2^{\text{attempts} - 1}$$
  The job is re-inserted into the Redis Sorted Set with `score = Date.now() + delay`. Workers only pop jobs where `score <= Date.now()`, ensuring retries are smoothly delayed.

### 4. Dead-Letter Queue (DLQ)
* **Problem**: Poison-pill jobs that repeatedly fail would consume infinite retries.
* **Solution**: When `attempts >= maxAttempts`, the job status transitions to `DEAD` and its ID is moved to `queue:dead` (Redis List) for inspection.

---

## 📁 Repository Structure

```text
distributed-task-queue/
├── server/
│   ├── redis.js          # Shared ioredis client singleton
│   ├── queue.js          # Core queue primitives (push, atomic pop, backoff, DLQ, stats)
│   ├── index.js          # Express API server (producers, stats, kill endpoints)
│   ├── worker.js         # Independent worker consumer process with heartbeat lease
│   └── watchdog.js       # Background failure detector & crash recovery monitor
├── client/               # React + Vite live observability dashboard
│   ├── src/
│   │   ├── App.jsx       # Real-time dashboard with metrics, logs, and worker kill controls
│   │   ├── index.css     # Dark-mode dashboard styling with live indicators
│   │   └── main.jsx      # React entrypoint
├── PROJECT_CONTEXT.md    # Detailed system design specification & mental model
└── package.json          # Server dependencies and orchestration scripts
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18+)
- **Redis** running locally on port `6379` (e.g. via Docker `docker run -d -p 6379:6379 redis:alpine`)

### 1. Install Dependencies
```bash
# In the root directory (Backend)
npm install

# In the client directory (Frontend Dashboard)
cd client && npm install && cd ..
```

### 2. Start the System

Open separate terminal windows or tabs to observe multi-process concurrency:

```bash
# Terminal 1: Start the API Server (Producer)
npm start

# Terminal 2: Start the Watchdog (Fault Tolerance Monitor)
npm run watchdog

# Terminal 3: Start Worker 1
npm run worker

# Terminal 4: Start Worker 2
npm run worker

# Terminal 5: Start Worker 3
npm run worker

# Terminal 6: Start Dashboard UI
cd client && npm run dev
```

Dashboard is accessible at **`http://localhost:5173`**.

---

## 🧪 How to Run the Live Fault-Tolerance Demo

1. Open `http://localhost:5173` in your browser.
2. In the **Submit Workload** panel:
   - Jobs: `50`
   - Max Duration: `8000` ms
   - Success Rate: `0.85`
   - Max Retries: `3`
3. Click **▶ Submit**.
4. Observe **all 3 workers** dynamically distributing the load in real time.
5. In the **Active Workers** table, click the **☠ Kill** button on one of the active workers.
6. **Watch the self-healing in action:**
   - The worker process is instantly terminated.
   - Its heartbeat lease expires after ~15 seconds.
   - The Watchdog logs: `[Watchdog] ⚠ Orphaned job detected... re-queued for recovery`.
   - Remaining active workers pick up the orphaned job and finish the workload.
   - **Zero jobs lost!**

---

## 📊 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/workload` | Submits a batch workload of simulated tasks with configured duration & failure rate |
| `GET` | `/stats` | Returns aggregate counts: `submitted`, `pending`, `processing`, `retrying`, `completed`, `failed`, `dead` |
| `GET` | `/workers` | Returns registered workers, current job in progress, and completed counts |
| `GET` | `/jobs/:id` | Returns full metadata and execution trace of a specific job |
| `POST` | `/workers/:id/kill` | Force-kills a worker process via `SIGKILL` to test watchdog failover |

---

## 💬 Interview Discussion Guide (Cheat Sheet)

| Question | Your Answer |
|---|---|
| **Why not just execute tasks in an Express request?** | Long tasks block the Node event loop and keep HTTP connections open, leading to timeouts and server unresponsiveness. A task queue decouples reception from execution. |
| **Why Redis Sorted Sets over Redis Lists?** | Lists only support FIFO/LIFO. Sorted Sets (`ZSET`) allow us to order by timestamp (`score`), which naturally gives us delayed execution and exponential backoff retry scheduling out of the box. |
| **How do you guarantee two workers don't grab the same job?** | Using `ZPOPMIN`, which atomically fetches and deletes the lowest-score entry in a single Redis command. |
| **How does crash recovery work if a worker is killed abruptly?** | Workers acquire a heartbeat key with a TTL in Redis and renew it periodically. If a worker dies, renewal stops and the key expires. The Watchdog identifies in-flight jobs without an active heartbeat and re-queues them. |
| **What are the limitations vs. production BullMQ?** | BullMQ uses Lua scripts for multi-step atomic operations, supports Redis Cluster sharding, priority levels, job progress streaming, and pub/sub event bridges. Our project implements the fundamental core algorithms cleanly from first principles. |
