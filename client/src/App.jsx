import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

const API = 'http://localhost:3000';
const POLL_MS = 250;

function fmt(n) { return (n ?? 0).toLocaleString(); }

function now() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function StatCard({ label, value, color, barColor }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${color}`}>{fmt(value)}</div>
      <div className="accent-bar" style={{ background: barColor }} />
    </div>
  );
}

function ProgressBar({ stats }) {
  const total = stats.submitted || 1;
  const done  = (stats.completed || 0) + (stats.dead || 0);
  const pct   = Math.min(100, Math.round((done / total) * 100));

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="card-title" style={{ margin: 0 }}>⚡ Overall Progress</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', color: 'var(--accent)' }}>
          {pct}%
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        <span><span className="c-green">■</span> Completed {fmt(stats.completed)}</span>
        <span><span className="c-blue">■</span> Pending {fmt(stats.pending)}</span>
        <span><span className="c-yellow">■</span> Processing {fmt(stats.processing)}</span>
        <span><span className="c-orange">■</span> Retrying {fmt(stats.retrying)}</span>
        <span><span className="c-red">■</span> Dead {fmt(stats.dead)}</span>
      </div>
    </div>
  );
}

function WorkloadForm({ onSubmit, loading }) {
  const [form, setForm] = useState({
    count: 100,
    maxDuration: 5000,
    successProbability: 0.85,
    maxAttempts: 3,
  });

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSubmit(e) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <div className="card">
      <div className="card-title">🚀 Submit Workload</div>
      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="field">
            <label>Jobs</label>
            <input id="count" type="number" min={1} max={10000}
              value={form.count}
              onChange={e => set('count', parseInt(e.target.value))} />
          </div>
          <div className="field">
            <label>Max Duration (ms)</label>
            <input id="maxDuration" type="number" min={100} max={30000}
              value={form.maxDuration}
              onChange={e => set('maxDuration', parseInt(e.target.value))} />
          </div>
          <div className="field">
            <label>Success % (0–1)</label>
            <input id="successProbability" type="number" step={0.05} min={0} max={1}
              value={form.successProbability}
              onChange={e => set('successProbability', parseFloat(e.target.value))} />
          </div>
          <div className="field">
            <label>Max Retries</label>
            <input id="maxAttempts" type="number" min={1} max={5}
              value={form.maxAttempts}
              onChange={e => set('maxAttempts', parseInt(e.target.value))} />
          </div>
          <button id="submit-workload" className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Submitting…' : '▶ Submit'}
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkerList({ workers, onKill }) {
  const [killing, setKilling] = useState(null);

  if (!workers.length) {
    return (
      <div className="empty">
        No active workers detected.<br />
        <span style={{ fontSize: '0.75rem', marginTop: 4, display: 'block' }}>
          Start workers in terminal: <code style={{ color: 'var(--accent)' }}>npm run worker</code>
        </span>
      </div>
    );
  }

  async function handleKill(worker) {
    setKilling(worker.id);
    await onKill(worker);
    setTimeout(() => setKilling(null), 1500);
  }

  return (
    <div>
      {workers.map(w => (
        <div key={w.id} className="worker-row">
          <div className={`worker-dot ${w.currentJobId ? 'active' : 'idle'}`} />
          <div className="worker-id">{w.id}</div>
          <div className="worker-job">
            {w.currentJobId
              ? `⚙ ${w.currentJobId.slice(0, 8)}…`
              : <span style={{ color: 'var(--text-muted)' }}>idle</span>}
          </div>
          <div className="worker-count">✓ {w.jobsProcessed}</div>
          <button
            id={`kill-${w.id}`}
            className="btn btn-kill"
            disabled={killing === w.id}
            onClick={() => handleKill(w)}
            title="Force-kill this worker process to test crash recovery"
          >
            {killing === w.id ? '…' : '☠ Kill'}
          </button>
        </div>
      ))}
    </div>
  );
}

function LogFeed({ logs }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="log-feed" ref={ref}>
      {logs.length === 0 && (
        <div style={{ color: 'var(--text-muted)' }}>Waiting for activity…</div>
      )}
      {logs.map((l, i) => (
        <div key={i} className="log-entry">
          <span className="log-time">{l.time}</span>
          <span className={`log-msg ${l.type}`}>{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

function PerfPanel({ stats, startTime }) {
  const elapsed  = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : '—';
  const total    = stats.submitted || 0;
  const done     = (stats.completed || 0) + (stats.dead || 0);
  const elapsed_s = startTime ? (Date.now() - startTime) / 1000 : 1;
  const throughput = startTime && elapsed_s > 0 ? (done / elapsed_s).toFixed(1) : '—';

  return (
    <div className="card">
      <div className="card-title">📊 Performance</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>THROUGHPUT</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '1.4rem', color: 'var(--accent-2)' }}>
            {throughput}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 4 }}>jobs/s</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>ELAPSED</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '1.4rem', color: 'var(--yellow)' }}>
            {elapsed}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 4 }}>sec</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>DONE / TOTAL</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: '1.4rem', color: 'var(--green)' }}>
            {fmt(done)}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/{fmt(total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [stats,   setStats]   = useState({});
  const [workers, setWorkers] = useState([]);
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast,   setToast]   = useState(null);
  const [startTime, setStartTime] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const prevStats = useRef({});

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(l => [...l.slice(-80), { time: now(), msg, type }]);
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const [s, w] = await Promise.all([
          fetch(`${API}/stats`).then(r => r.json()),
          fetch(`${API}/workers`).then(r => r.json()),
        ]);

        if (!active) return;

        const prev = prevStats.current;

        if (s.completed > (prev.completed || 0)) {
          const delta = s.completed - (prev.completed || 0);
          addLog(`✓ ${delta} job(s) completed (Total: ${s.completed})`, 'success');
        }
        if (s.failed > (prev.failed || 0)) {
          const delta = s.failed - (prev.failed || 0);
          addLog(`✗ ${delta} job(s) failed — retrying if attempts remain`, 'fail');
        }
        if (s.dead > (prev.dead || 0)) {
          const delta = s.dead - (prev.dead || 0);
          addLog(`💀 ${delta} job(s) moved to Dead-Letter Queue`, 'dead');
        }
        if (s.retrying > (prev.retrying || 0)) {
          addLog(`↺ Jobs retrying with exponential backoff`, 'retry');
        }

        prevStats.current = s;
        setStats(s);
        setWorkers(w.workers || []);
      } catch {
        // Backend not reachable yet
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, [addLog]);

  async function handleSubmit(form) {
    setLoading(true);
    try {
      const res = await fetch(`${API}/workload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setStartTime(Date.now());
      addLog(`🚀 Submitted ${data.submitted} jobs to the queue`, 'info');
      showToast(`✓ ${data.submitted} jobs queued`);
    } catch (err) {
      addLog(`✗ Submit failed: ${err.message}`, 'fail');
    } finally {
      setLoading(false);
    }
  }

  async function handleKillWorker(worker) {
    try {
      const res = await fetch(`${API}/workers/${worker.id}/kill`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      addLog(`☠ Killed ${worker.id} (PID ${data.pid}) — Watchdog will recover orphaned jobs`, 'fail');
      showToast(`☠ ${worker.id} killed — Watchdog recovering…`);
    } catch (err) {
      addLog(`✗ Failed to kill worker: ${err.message}`, 'fail');
    }
  }

  async function handleReset() {
    try {
      const res = await fetch(`${API}/reset`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStats({});
      setLogs([]);
      setStartTime(null);
      prevStats.current = {};
      setConfirmReset(false);
      addLog('🔄 Redis database reset and stats cleared', 'info');
      showToast('✓ All queues and stats reset');
    } catch (err) {
      setConfirmReset(false);
      addLog(`✗ Failed to reset: ${err.message}`, 'fail');
    }
  }

  return (
    <div className="app">

      <header className="header">
        <div className="header-left">
          <div className="logo-icon">⚡</div>
          <div>
            <h1>Distributed Task Queue</h1>
            <div className="header-sub">Built from scratch · Node.js + Redis</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {confirmReset ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(246,224,94,0.08)', border: '1px solid rgba(246,224,94,0.3)', borderRadius: '8px', padding: '5px 12px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--yellow)' }}>Reset all data?</span>
              <button id="confirm-reset-yes" className="btn btn-kill" style={{ padding: '3px 10px', fontSize: '0.72rem' }} onClick={handleReset}>Yes</button>
              <button id="confirm-reset-cancel" className="btn btn-reset" style={{ padding: '3px 10px', fontSize: '0.72rem' }} onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          ) : (
            <button
              id="reset-queue-btn"
              className="btn btn-reset"
              onClick={() => setConfirmReset(true)}
              title="Reset stats and flush queue data in Redis"
            >
              🔄 Reset / Clear
            </button>
          )}
          <div className="live-badge">
            <div className="live-dot" />
            LIVE — polling every {POLL_MS / 1000}s
          </div>
        </div>
      </header>

      <WorkloadForm onSubmit={handleSubmit} loading={loading} />

      <div className="grid-7">
        <StatCard label="Submitted"  value={stats.submitted}  color="c-blue"   barColor="var(--accent)" />
        <StatCard label="Pending"    value={stats.pending}    color="c-teal"   barColor="var(--accent-2)" />
        <StatCard label="Processing" value={stats.processing} color="c-yellow" barColor="var(--yellow)" />
        <StatCard label="Retrying"   value={stats.retrying}   color="c-orange" barColor="var(--orange)" />
        <StatCard label="Completed"  value={stats.completed}  color="c-green"  barColor="var(--green)" />
        <StatCard label="Failed"     value={stats.failed}     color="c-red"    barColor="var(--red)" />
        <StatCard label="Dead"       value={stats.dead}       color="c-purple" barColor="var(--purple)" />
      </div>

      <ProgressBar stats={stats} />

      <div className="grid-2">
        <div className="card">
          <div className="card-title">
            👷 Active Workers
            <span style={{ marginLeft: 'auto', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
              {workers.length} online
            </span>
          </div>
          <WorkerList workers={workers} onKill={handleKillWorker} />
        </div>

        <div className="card">
          <div className="card-title">📋 Activity Log</div>
          <LogFeed logs={logs} />
        </div>
      </div>

      <PerfPanel stats={stats} startTime={startTime} />

      {toast && <div className="toast">{toast}</div>}

    </div>
  );
}
