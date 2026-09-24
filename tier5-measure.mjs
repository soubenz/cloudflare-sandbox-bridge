// Tier 5 perf measurement against the live deployment. Temporary: delete when done.
// Never logs the API key.

const BASE = process.env.OPALIX_URL ?? 'https://opalix-sandbox.soubenz94.workers.dev';
const KEY = process.env.SANDBOX_API_KEY;
if (!KEY) throw new Error('SANDBOX_API_KEY not in env');

const OUT = process.env.OUT ?? '/tmp/tier5.jsonl';
const fs = await import('node:fs');

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const emit = (rec) => fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const poolStats = () => req('GET', '/pools/agent');
const prime = (target) => req('POST', '/pools/agent/prime', { target });

// --- one measured session ---------------------------------------------------
// t0 = the instant the POST /sessions response is fully received.
// t1 = the instant a GET /sessions/{id} first reports meta.state === 'running'.
async function measureOne(tag, i) {
  const userId = `tier5-${tag}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const before = await poolStats();

  const postStart = Date.now();
  const created = await req('POST', '/sessions', { lab: 'hello', user_id: userId });
  const t0 = Date.now();
  const id = created.id;
  log(`${tag}#${i} session ${id} (POST ${t0 - postStart}ms, state=${created.state})`);

  const rec = {
    tag, i, session_id: id, user_id: userId,
    post_ms: t0 - postStart,
    pool_before: { warm: before.warm, ...before.stats },
    polls: 0,
  };

  try {
    let t1 = null, echoHealthyAt = null, statusAtRunning = null;
    const deadline = t0 + 240_000;
    while (Date.now() < deadline) {
      const st = await req('GET', `/sessions/${id}`);
      rec.polls += 1;
      const now = Date.now();
      const state = st.meta.state;
      if (t1 === null && state === 'running') {
        t1 = now;
        statusAtRunning = { services: st.services, started_at: st.meta.started_at };
        rec.to_running_ms = t1 - t0;
        rec.echo_health_at_running = st.services?.echo?.health ?? null;
        log(`${tag}#${i} running in ${rec.to_running_ms}ms, echo=${rec.echo_health_at_running}`);
      }
      if (t1 !== null) {
        if (st.services?.echo?.health === 'healthy') {
          echoHealthyAt = now;
          rec.echo_healthy_after_running_ms = echoHealthyAt - t1;
          break;
        }
        // running but echo not healthy yet: keep polling (bounded)
        if (now - t1 > 60_000) { rec.echo_healthy_after_running_ms = null; rec.echo_note = 'not healthy within 60s of running'; break; }
      }
      if (state === 'failed' || state === 'ended' || state === 'expired') {
        rec.error = `session reached terminal state ${state}`;
        break;
      }
      await sleep(250);
    }
    if (t1 === null && !rec.error) rec.error = 'timed out waiting for running (240s)';
    rec.status_at_running = statusAtRunning;
  } catch (err) {
    rec.error = String(err.message ?? err);
  } finally {
    // ALWAYS end the session.
    for (let a = 0; a < 3; a++) {
      try { await req('DELETE', `/sessions/${id}?snapshot=0`); rec.deleted = true; break; }
      catch (e) { rec.delete_error = String(e.message ?? e); await sleep(1500); }
    }
    log(`${tag}#${i} deleted=${rec.deleted === true}`);
  }

  const after = await poolStats();
  rec.pool_after = { warm: after.warm, ...after.stats };
  rec.claim_was_warm = after.stats.warm_hits - before.stats.warm_hits === 1;
  rec.claim_was_cold = after.stats.cold_misses - before.stats.cold_misses === 1;
  rec.classified = rec.claim_was_warm ? 'warm' : rec.claim_was_cold ? 'cold' : 'ambiguous';
  log(`${tag}#${i} classified=${rec.classified} to_running=${rec.to_running_ms}ms`);
  emit(rec);
  return rec;
}

// --- phases -----------------------------------------------------------------
const MAX_STARTS = Number(process.env.MAX_STARTS ?? 15);
let starts = 0;
const cold = [], warm = [];

async function coldPhase(n) {
  while (cold.length < n && starts < MAX_STARTS) {
    await prime(0);
    let p = await poolStats();
    if (p.warm > 0) {
      log(`! pool has warm=${p.warm} despite target 0 (cron re-primes every 5 min); this start will be a warm hit -> counting it toward the warm bucket`);
    }
    starts += 1;
    const rec = await measureOne(p.warm > 0 ? 'stray-warm' : 'cold', cold.length + 1);
    if (rec.classified === 'cold') cold.push(rec);
    else if (rec.classified === 'warm') warm.push(rec);
    log(`>> cold=${cold.length}/${n} warm=${warm.length} starts=${starts}`);
    await sleep(1000);
  }
}

async function warmPhase(n) {
  while (warm.length < n && starts < MAX_STARTS) {
    await prime(2);
    // wait for 2 warm entries
    let p = await poolStats();
    for (let w = 0; w < 40 && p.warm < 2; w++) { await sleep(1500); await prime(2); p = await poolStats(); }
    log(`warm pool ready: warm=${p.warm}`);
    starts += 1;
    const rec = await measureOne('warm', warm.length + 1);
    if (rec.classified === 'warm') warm.push(rec);
    else if (rec.classified === 'cold') cold.push(rec);
    log(`>> warm=${warm.length}/${n} cold=${cold.length} starts=${starts}`);
    await sleep(1000);
  }
}

const phase = process.argv[2] ?? 'all';
try {
  log('start pool:', JSON.stringify(await poolStats()));
  if (phase === 'all' || phase === 'cold') await coldPhase(Number(process.env.N_COLD ?? 10));
  if (phase === 'all' || phase === 'warm') await warmPhase(Number(process.env.N_WARM ?? 5));
} finally {
  const final = await poolStats();
  log('FINAL POOL', JSON.stringify(final));
  emit({ tag: 'final_pool', ...final });

  const stat = (arr) => {
    const v = arr.map((r) => r.to_running_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (!v.length) return null;
    const q = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
    return { n: v.length, min: v[0], p50: q(50), p95: q(95), max: v[v.length - 1], mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), all: v };
  };
  const summary = { cold: stat(cold), warm: stat(warm), starts,
    echo_health_at_running: [...cold, ...warm].map((r) => r.echo_health_at_running),
    echo_healthy_after_running_ms: [...cold, ...warm].map((r) => r.echo_healthy_after_running_ms) };
  log('SUMMARY', JSON.stringify(summary, null, 2));
  emit({ tag: 'summary', ...summary });
}
