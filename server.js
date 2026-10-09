'use strict';
/*
 * bl-panel — panel de telemetrie Brothers Life (site + API), un seul service.
 *  - POST /v1/batch           : ingestion FiveM (Bearer INGEST_TOKEN)
 *  - GET  /api/*              : stats pour le site (session cookie apres /api/login)
 *  - GET  /                   : site (public/)
 *  - Scraper /perf/ + /dynamic.json toutes les 15 s, retention RETENTION_DAYS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TOKEN = process.env.INGEST_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const FIVEM_BASE = (process.env.FIVEM_BASE || '').replace(/\/$/, '');
const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS || '15000', 10);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '365', 10);
const MAX_BODY = 5 * 1024 * 1024;

if (!TOKEN) {
  console.error('INGEST_TOKEN manquant — refus de demarrer.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });

async function initSchema() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Schema OK');
}

/* ------------------------------ utilitaires ------------------------------ */

const MAX_MONEY = 9e15;
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-MAX_MONEY, Math.min(MAX_MONEY, Math.round(n)));
}

const q = (text, values) => pool.query(text, values).catch((e) => { console.error('pg:', e.message, text.slice(0, 60)); return { rows: [] }; });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS_ORIGIN });
  res.end(JSON.stringify(obj));
}

/* --------------------------------- auth --------------------------------- */

function sign(v) { return crypto.createHmac('sha256', TOKEN).update(v).digest('hex'); }
function makeSession() { const exp = Date.now() + 7 * 86400e3; return exp + '.' + sign('sess' + exp); }
function sessionValid(cookieHeader) {
  const m = /(?:^|;\s*)blp=([^;]+)/.exec(cookieHeader || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig) return false;
  if (Date.now() > Number(exp)) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign('sess' + exp))); } catch { return false; }
}
function ingestAuthorized(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7) === TOKEN;
  if (h.startsWith('Basic ')) {
    try { const dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); return dec.slice(dec.indexOf(':') + 1) === TOKEN; } catch { return false; }
  }
  return false;
}

/* ------------------------------- ingestion ------------------------------- */

async function handleEvent(ev) {
  const d = ev.data || {};
  const cid = ev.citizenid || d.citizenid || null;
  const name = ev.player_name || d.player_name || null;
  await q('INSERT INTO events (ts, type, subtype, citizenid, player_name, src, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7)',
    [ev.ts || Date.now(), ev.type || 'unknown', ev.subtype || null, cid, name, ev.src || null, JSON.stringify(d)]);
  switch (ev.type) {
    case 'economy_snapshot':
      await q('INSERT INTO economy_snapshots (ts, player_count, chars_total, total_cash, total_bank, total_crypto, society_total, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8)',
        [ev.ts || Date.now(), d.player_count, d.chars_total, num(d.total_cash), num(d.total_bank), num(d.total_crypto), num(d.society_total), JSON.stringify(d.extra || {})]);
      break;
    case 'player_snapshot':
      await q('INSERT INTO player_snapshots (ts, citizenid, name, job, job_grade, gang, cash, bank, crypto, online, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [ev.ts || Date.now(), cid, name, d.job, d.job_grade, d.gang, num(d.cash), num(d.bank), num(d.crypto), !!d.online, JSON.stringify(d.extra || {})]);
      break;
    case 'purchase':
      await q('INSERT INTO purchases (ts, citizenid, player_name, shop, item, label, qty, unit_price, total, currency, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [ev.ts || Date.now(), cid, name, d.shop, d.item, d.label, d.qty || 1, num(d.unit_price), num(d.total), d.currency || 'cash', JSON.stringify(d.extra || {})]);
      break;
    case 'death':
      await q('INSERT INTO deaths (ts, citizenid, player_name, cause, killer_cid, killer_name, weapon, x, y, z, screenshot_url, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [ev.ts || Date.now(), cid, name, d.cause, d.killer_cid, d.killer_name, d.weapon, d.x, d.y, d.z, d.screenshot_url, JSON.stringify(d.extra || {})]);
      break;
    case 'session_start':
      await q('INSERT INTO sessions (citizenid, player_name, license, src, start_ts) VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0))',
        [cid, name, d.license, ev.src, ev.ts || Date.now()]);
      break;
    case 'session_end':
      await q(`UPDATE sessions SET end_ts = to_timestamp($1/1000.0), drop_reason = $2,
           duration_min = EXTRACT(EPOCH FROM (to_timestamp($1/1000.0) - start_ts)) / 60.0
         WHERE id = (SELECT id FROM sessions WHERE (citizenid = $3 OR license = $4) AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1)`,
        [ev.ts || Date.now(), d.reason, cid, d.license]);
      break;
    case 'vehicle_snapshot':
      await q('INSERT INTO vehicles_owned (ts, citizenid, owner_name, plate, model, garage, state, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8)',
        [ev.ts || Date.now(), cid, name, d.plate, d.model, d.garage, d.state, JSON.stringify(d.extra || {})]);
      break;
    case 'admin_action':
      await q('INSERT INTO admin_actions (ts, action, admin_name, target_cid, target_name, reason, duration, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8)',
        [ev.ts || Date.now(), d.action, d.admin_name, d.target_cid, d.target_name, d.reason, d.duration, JSON.stringify(d.extra || {})]);
      break;
  }
}

async function handleBatch(body) {
  const events = Array.isArray(body.events) ? body.events : [];
  const logs = Array.isArray(body.logs) ? body.logs : [];
  for (const ev of events) await handleEvent(ev);
  for (const lg of logs) {
    const labels = lg.labels || {};
    await q('INSERT INTO server_logs (ts, channel, level, source, line, labels) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6)',
      [lg.ts || Date.now(), labels.channel || null, labels.level || null, labels.source || 'fivem', String(lg.line || '').slice(0, 4000), JSON.stringify(labels)]);
  }
  return { ok: true, events: events.length, logs: logs.length };
}

/* ----------------------------- scraper FiveM ----------------------------- */

function parsePerf(text) {
  const metrics = []; const buckets = {}; const sums = {}, counts = {};
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^tickTime_bucket\{name="([^"]+)",le="([^"]+)"\} ([0-9.e+]+)/))) {
      (buckets[m[1]] = buckets[m[1]] || []).push({ le: parseFloat(m[2]), v: parseFloat(m[3]) });
    } else if ((m = line.match(/^tickTime_sum\{name="([^"]+)"\} ([0-9.e+-]+)/))) sums[m[1]] = parseFloat(m[2]);
    else if ((m = line.match(/^tickTime_count\{name="([^"]+)"\} ([0-9.e+]+)/))) counts[m[1]] = parseFloat(m[2]);
  }
  for (const [name, bs] of Object.entries(buckets)) {
    bs.sort((a, b) => a.le - b.le);
    metrics.push({ metric: 'tick_count', thread: name, value: counts[name] || 0 });
    metrics.push({ metric: 'tick_sum_sec', thread: name, value: sums[name] || 0 });
    for (const b of bs) if (Number.isFinite(b.le)) metrics.push({ metric: 'tick_bucket', thread: name, le: b.le, value: b.v });
  }
  return metrics;
}

let lastScrapeOk = null;
async function scrapeOnce() {
  if (!FIVEM_BASE) return;
  const ts = Date.now();
  try {
    const [perfR, dynR] = await Promise.all([
      fetch(FIVEM_BASE + '/perf/', { signal: AbortSignal.timeout(8000) }),
      fetch(FIVEM_BASE + '/dynamic.json', { signal: AbortSignal.timeout(8000) }),
    ]);
    const rows = [];
    if (perfR.ok) for (const p of parsePerf(await perfR.text())) rows.push([ts, p.metric, p.thread || null, p.le ?? null, p.value]);
    if (dynR.ok) {
      const dyn = await dynR.json();
      rows.push([ts, 'players_online', null, null, parseInt(dyn.clients, 10) || 0]);
      rows.push([ts, 'players_max', null, null, parseInt(dyn.sv_maxclients, 10) || 0]);
    }
    rows.push([ts, 'server_up', null, null, perfR.ok ? 1 : 0]);
    for (const r of rows) await q('INSERT INTO perf_metrics (ts, metric, thread, le, value) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5)', r);
    lastScrapeOk = ts;
  } catch (e) {
    await q('INSERT INTO perf_metrics (ts, metric, thread, le, value) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5)', [ts, 'server_up', null, null, 0]);
  }
}

async function purgeOld() {
  for (const t of ['events', 'server_logs', 'perf_metrics', 'player_snapshots', 'economy_snapshots', 'vehicles_owned']) {
    await q(`DELETE FROM ${t} WHERE ts < now() - interval '${RETENTION_DAYS} days'`);
  }
}

/* ------------------------------- API stats ------------------------------- */

function hoursParam(url, def) {
  const h = parseInt(new URL(url, 'http://x').searchParams.get('h') || String(def), 10);
  return Math.min(Math.max(h || def, 1), 24 * 90);
}

const api = {
  async overview(url) {
    const h = hoursParam(url, 24);
    const [online, tick, counts, errors, up] = await Promise.all([
      q(`SELECT extract(epoch FROM ts)*1000 AS t, value FROM perf_metrics WHERE metric='players_online' AND ts > now() - interval '${h} hours' ORDER BY ts`),
      q(`WITH s AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric='tick_sum_sec' AND ts > now() - interval '${h} hours'),
               c AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric='tick_count' AND ts > now() - interval '${h} hours')
         SELECT extract(epoch FROM s.ts)*1000 AS t, s.thread,
                (s.v - lag(s.v) OVER (PARTITION BY s.thread ORDER BY s.ts)) / NULLIF(c.v - lag(c.v) OVER (PARTITION BY c.thread ORDER BY c.ts),0) * 1000 AS ms
         FROM s JOIN c ON c.ts = s.ts AND c.thread = s.thread ORDER BY 1`),
      q(`SELECT
          (SELECT value FROM perf_metrics WHERE metric='players_online' ORDER BY ts DESC LIMIT 1) AS online,
          (SELECT value FROM perf_metrics WHERE metric='players_max' ORDER BY ts DESC LIMIT 1) AS max,
          (SELECT value FROM perf_metrics WHERE metric='server_up' ORDER BY ts DESC LIMIT 1) AS up,
          (SELECT chars_total FROM economy_snapshots ORDER BY ts DESC LIMIT 1) AS chars,
          (SELECT COUNT(*) FROM events WHERE ts > now() - interval '24 hours') AS events24,
          (SELECT COUNT(*) FROM server_logs WHERE ts > now() - interval '24 hours') AS logs24,
          (SELECT COUNT(*) FROM sessions WHERE start_ts > now() - interval '24 hours') AS sessions24,
          (SELECT COUNT(*) FROM deaths WHERE ts > now() - interval '24 hours') AS deaths24`),
      q(`SELECT ts, channel, line FROM server_logs WHERE level='error' ORDER BY ts DESC LIMIT 50`),
      q(`SELECT extract(epoch FROM ts)*1000 AS t, value FROM perf_metrics WHERE metric='server_up' AND ts > now() - interval '${h} hours' ORDER BY ts`),
    ]);
    return { online: online.rows, tick: tick.rows, counts: counts.rows[0] || {}, errors: errors.rows, up: up.rows };
  },
  async economy(url) {
    const h = hoursParam(url, 24 * 7);
    const [mass, top, shops, purchases, flows, flowsByHour] = await Promise.all([
      q(`SELECT extract(epoch FROM ts)*1000 AS t, total_cash, total_bank FROM economy_snapshots WHERE ts > now() - interval '${h} hours' ORDER BY ts`),
      q(`SELECT name, citizenid, cash, bank, cash+bank AS total FROM (SELECT DISTINCT ON (citizenid) citizenid, name, cash, bank FROM player_snapshots ORDER BY citizenid, ts DESC) t ORDER BY total DESC NULLS LAST LIMIT 20`),
      q(`SELECT COALESCE(shop,'?') AS shop, SUM(total) AS ca, COUNT(*) AS n FROM purchases WHERE ts > now() - interval '${h} hours' GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 15`),
      q(`SELECT ts, player_name, citizenid, shop, COALESCE(label,item) AS article, qty, total, currency FROM purchases ORDER BY ts DESC LIMIT 100`),
      q(`SELECT ts, data->>'kind' AS kind, data->>'from_cid' AS from_cid, data->>'to_cid' AS to_cid, (data->>'amount')::numeric AS amount, data->>'note' AS note FROM events WHERE subtype='bank_flow' ORDER BY ts DESC LIMIT 100`),
      q(`SELECT date_trunc('hour', ts) AS t, COALESCE(data->>'kind','?') AS kind, SUM((data->>'amount')::numeric) AS total FROM events WHERE subtype='bank_flow' AND ts > now() - interval '${h} hours' GROUP BY 1,2 ORDER BY 1`),
    ]);
    return { mass: mass.rows, top: top.rows, shops: shops.rows, purchases: purchases.rows, flows: flows.rows, flowsByHour: flowsByHour.rows };
  },
  async players(url) {
    const s = (new URL(url, 'http://x').searchParams.get('q') || '').slice(0, 60);
    const r = await q(`SELECT DISTINCT ON (citizenid) citizenid, name, job, gang, cash, bank, online, ts
                       FROM player_snapshots ${s ? "WHERE name ILIKE $1 OR citizenid ILIKE $1" : ''}
                       ORDER BY citizenid, ts DESC LIMIT 300`, s ? ['%' + s + '%'] : []);
    return { players: r.rows.sort((a, b) => (b.cash + b.bank) - (a.cash + a.bank)) };
  },
  async player(url) {
    const cid = (new URL(url, 'http://x').searchParams.get('cid') || '').slice(0, 60);
    if (!cid) return { error: 'cid requis' };
    const [ident, money, deaths, purchases, sessions, vehicles, inventory, events, flows, stats] = await Promise.all([
      q('SELECT name, citizenid, job, job_grade, gang, cash, bank, crypto, online, ts FROM player_snapshots WHERE citizenid=$1 ORDER BY ts DESC LIMIT 1', [cid]),
      q(`SELECT extract(epoch FROM ts)*1000 AS t, cash, bank FROM player_snapshots WHERE citizenid=$1 AND ts > now() - interval '30 days' ORDER BY ts`, [cid]),
      q('SELECT ts, cause, killer_name, weapon FROM deaths WHERE citizenid=$1 ORDER BY ts DESC LIMIT 50', [cid]),
      q('SELECT ts, shop, COALESCE(label,item) AS article, qty, total FROM purchases WHERE citizenid=$1 ORDER BY ts DESC LIMIT 50', [cid]),
      q('SELECT start_ts, end_ts, ROUND(duration_min::numeric,1) AS minutes, drop_reason FROM sessions WHERE citizenid=$1 ORDER BY start_ts DESC LIMIT 50', [cid]),
      q('SELECT DISTINCT ON (plate) plate, model, garage, state FROM vehicles_owned WHERE citizenid=$1 ORDER BY plate, ts DESC', [cid]),
      q(`SELECT it->>'n' AS name, (it->>'c')::int AS count FROM (SELECT data AS d FROM player_snapshots WHERE citizenid=$1 AND data->'inventory' IS NOT NULL ORDER BY ts DESC LIMIT 1) s, jsonb_array_elements(s.d->'inventory') it ORDER BY 2 DESC`, [cid]),
      q('SELECT ts, type, subtype, data FROM events WHERE citizenid=$1 ORDER BY ts DESC LIMIT 100', [cid]),
      q(`SELECT ts, data->>'kind' AS kind, data->>'from_cid' AS from_cid, data->>'to_cid' AS to_cid, (data->>'amount')::numeric AS amount, data->>'note' AS note FROM events WHERE subtype='bank_flow' AND (data->>'from_cid'=$1 OR data->>'to_cid'=$1) ORDER BY ts DESC LIMIT 100`, [cid]),
      q(`SELECT (SELECT COALESCE(SUM(duration_min),0)/60.0 FROM sessions WHERE citizenid=$1) AS hours,
                (SELECT COUNT(*) FROM deaths WHERE citizenid=$1) AS deaths,
                (SELECT COUNT(*) FROM purchases WHERE citizenid=$1) AS purchases`, [cid]),
    ]);
    return { ident: ident.rows[0] || null, money: money.rows, deaths: deaths.rows, purchases: purchases.rows, sessions: sessions.rows, vehicles: vehicles.rows, inventory: inventory.rows, events: events.rows, flows: flows.rows, stats: stats.rows[0] || {} };
  },
  async logs(url) {
    const p = new URL(url, 'http://x').searchParams;
    const s = (p.get('q') || '').slice(0, 100);
    const level = (p.get('level') || '').slice(0, 10);
    const args = []; const cond = [];
    if (s) { args.push('%' + s + '%'); cond.push(`line ILIKE $${args.length}`); }
    if (level) { args.push(level); cond.push(`level = $${args.length}`); }
    const [rows, chat, volume] = await Promise.all([
      q(`SELECT ts, channel, level, line FROM server_logs ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY ts DESC LIMIT 400`, args),
      q(`SELECT ts, player_name, citizenid, subtype, data->>'message' AS message FROM events WHERE subtype IN ('chat','command') ORDER BY ts DESC LIMIT 150`),
      q(`SELECT date_trunc('minute', ts) AS t, COALESCE(level,'info') AS level, COUNT(*) AS n FROM server_logs WHERE ts > now() - interval '6 hours' GROUP BY 1,2 ORDER BY 1`),
    ]);
    return { logs: rows.rows, chat: chat.rows, volume: volume.rows };
  },
  async admin() {
    const [actions, connections, explosions, deathsByHour] = await Promise.all([
      q(`SELECT ts, data->>'action' AS action, data->>'admin_name' AS staff, data->>'target_name' AS target, data->>'reason' AS reason, data->>'duration' AS duration FROM events WHERE type='admin_action' ORDER BY ts DESC LIMIT 150`),
      q(`SELECT start_ts, end_ts, player_name, citizenid, drop_reason FROM sessions ORDER BY start_ts DESC LIMIT 150`),
      q(`SELECT ts, player_name, citizenid, data->>'explosion_type' AS type FROM events WHERE subtype='explosion' ORDER BY ts DESC LIMIT 100`),
      q(`SELECT date_trunc('hour', ts) AS t, COUNT(*) AS n FROM deaths WHERE ts > now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
    ]);
    return { actions: actions.rows, connections: connections.rows, explosions: explosions.rows, deathsByHour: deathsByHour.rows };
  },
};

/* --------------------------------- static -------------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : path.basename(urlPath);
  const file = path.join(__dirname, 'ui', name);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(fs.readFileSync(file));
    return true;
  }
  return false;
}

/* --------------------------------- serveur -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': CORS_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, lastScrapeOk });

    if (req.method === 'POST' && url === '/v1/batch') {
      if (!ingestAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
      const raw = await readBody(req);
      return json(res, 200, await handleBatch(JSON.parse(raw.toString('utf8'))));
    }

    if (req.method === 'POST' && url === '/api/login') {
      const raw = await readBody(req);
      let pass = '';
      try { pass = JSON.parse(raw.toString('utf8')).password || ''; } catch {}
      const okBuf = Buffer.from(sign('pw' + pass));
      const refBuf = Buffer.from(sign('pw' + ADMIN_PASSWORD));
      if (okBuf.length === refBuf.length && crypto.timingSafeEqual(okBuf, refBuf)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `blp=${makeSession()}; HttpOnly; Secure; Path=/; Max-Age=${7 * 86400}; SameSite=Lax` });
        res.end(JSON.stringify({ ok: true }));
      } else json(res, 401, { error: 'mauvais mot de passe' });
      return;
    }

    if (url.startsWith('/api/')) {
      const name = url.slice(5);
      if (api[name]) return json(res, 200, await api[name](req.url));
      return json(res, 404, { error: 'inconnu' });
    }

    if (req.method === 'GET' && url === '/') return json(res, 200, { service: 'bl-panel-api', ok: true });
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('req error:', e.message);
    json(res, 500, { error: 'internal' });
  }
});

initSchema().then(() => {
  server.listen(PORT, () => console.log('bl-panel on :' + PORT));
  if (FIVEM_BASE) { scrapeOnce(); setInterval(scrapeOnce, SCRAPE_INTERVAL_MS); }
  purgeOld(); setInterval(purgeOld, 24 * 3600 * 1000);
}).catch((e) => { console.error('init failed:', e); process.exit(1); });
