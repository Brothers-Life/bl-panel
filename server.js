'use strict';
/*
 * bl-panel — panel de telemetrie Brothers Life (site + API), un seul service.
 *  - POST /v1/batch           : ingestion FiveM (Bearer INGEST_TOKEN)
 *  - GET  /api/*              : donnees pour le panel (cle PANEL_API_KEY ; la connexion Discord est geree par le panel)
 *  - /api/panel-users         : stockage des comptes du panel (voir panel-users.js)
 *  - journal joueur, recherche, origine d'un saut d'argent, inflation, scripts, annonces : voir features.js
 *  - GET  /                   : site (public/)
 *  - GET  /api/stream         : flux temps reel (Server-Sent Events)
 *  - Scraper /perf/ + /dynamic.json toutes les 15 s, retention RETENTION_DAYS.
 *  - Moteur d'alertes (serveur tombe, rafale d'erreurs, anticheat, saut d'argent) -> table alerts + Discord.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Charge le fichier .env s'il existe (sans dependance) ; les variables deja definies gardent la priorite.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* pas de .env : variables d'environnement de l'hebergeur */ }
// Nettoie les variables : espaces autour et commentaire en fin de ligne (" # ...") colles par erreur.
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string') { const c = v.replace(/\s+#.*$/, '').trim(); if (c !== v) process.env[k] = c; }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const TOKEN = process.env.INGEST_TOKEN || '';
const PANEL_API_KEY = process.env.PANEL_API_KEY || '';
const FIVEM_BASE = (process.env.FIVEM_BASE || '').replace(/\/$/, '');
const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS || '15000', 10);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '365', 10);
const MAX_BODY = 5 * 1024 * 1024;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ALERT_INTERVAL_MS = parseInt(process.env.ALERT_INTERVAL_MS || '60000', 10);
const ALERT_ERRORS_5MIN = parseInt(process.env.ALERT_ERRORS_5MIN || '25', 10);
const ALERT_MONEY_JUMP = parseInt(process.env.ALERT_MONEY_JUMP || '1000000', 10);
const ALERT_ANTICHEAT_CHANNEL = process.env.ALERT_ANTICHEAT_CHANNEL || 'anticheat';
const PANEL_TZ = process.env.PANEL_TZ || 'Europe/Paris';

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

const CORS_HEADERS = { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*' };
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS });
  res.end(JSON.stringify(obj));
}

/* --------------------------------- auth --------------------------------- */

// Seul le panel lit l'API : il envoie la cle partagee PANEL_API_KEY dans l'en-tete X-Panel-Key.
function panelAuthorized(req) {
  if (!PANEL_API_KEY) return true;
  const got = Buffer.from(String(req.headers['x-panel-key'] || ''));
  const ref = Buffer.from(PANEL_API_KEY);
  return got.length === ref.length && crypto.timingSafeEqual(got, ref);
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

const anticheatCooldown = new Map();

/* Resultats de lecture de la base du jeu (bl_telemetry/dbsync) : on garde la derniere version de chacun. */
async function handleDbSnapshot(d) {
  const name = String(d.name || '');
  if (!/^[\w-]{1,60}$/.test(name) || !Array.isArray(d.rows) || !Array.isArray(d.columns)) return;
  const rows = d.rows.slice(0, 5000);
  const columns = d.columns.slice(0, 30).map((c) => String(c).slice(0, 60));
  await q(`INSERT INTO db_snapshots (name, label, kind, pos, ts, columns, rows) VALUES ($1, $2, $3, $4, now(), $5, $6)
           ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind, pos = EXCLUDED.pos, ts = now(),
             columns = EXCLUDED.columns, rows = EXCLUDED.rows`,
    [name, String(d.label || name).slice(0, 120), String(d.kind || 'table').slice(0, 20), Number.isInteger(d.pos) ? d.pos : null,
      JSON.stringify(columns), JSON.stringify(rows)]);
  if (name === '_tables') {
    await q(`INSERT INTO db_table_stats (table_name, rows, bytes) SELECT * FROM unnest($1::text[], $2::bigint[], $3::bigint[])`,
      [rows.map((r) => String(r[0]).slice(0, 120)), rows.map((r) => num(r[1])), rows.map((r) => num(r[2]))]);
  }
}

async function handleEvent(ev) {
  const d = ev.data || {};
  if (ev.type === 'db_snapshot') return handleDbSnapshot(d); // volumineux : pas recopie dans events
  const cid = ev.citizenid || d.citizenid || null;
  const name = ev.player_name || d.player_name || null;
  await q('INSERT INTO events (ts, type, subtype, citizenid, player_name, src, data) VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7)',
    [ev.ts || Date.now(), ev.type || 'unknown', ev.subtype || null, cid, name, ev.src || null, JSON.stringify(d)]);
  if (ev.subtype === 'character_loaded' && (d.license || ev.src)) {
    // Rattache la session ouverte (creee a la connexion, sans personnage) au personnage charge.
    await q(`UPDATE sessions SET citizenid = $1, player_name = COALESCE($2, player_name)
       WHERE id = (SELECT id FROM sessions WHERE end_ts IS NULL AND citizenid IS NULL
                   AND (license = $3 OR ($3 IS NULL AND src = $4)) ORDER BY start_ts DESC LIMIT 1)`,
      [cid, name, d.license || null, ev.src || null]);
  }
  switch (ev.type) {
    case 'anticheat': {
      const reason = String(d.reason || 'détection').slice(0, 120);
      const key = (cid || ev.src || '?') + ':' + reason;
      if (Date.now() - (anticheatCooldown.get(key) || 0) > 2 * 60e3) {
        anticheatCooldown.set(key, Date.now());
        const details = d.details && typeof d.details === 'object'
          ? Object.entries(d.details).map(([k, v]) => `${k} : ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
          : '';
        await raiseAlert('anticheat', 'critical', `Anticheat : ${name || cid || 'joueur ' + (ev.src ?? '?')} — ${reason}`,
          (cid ? `citizenid ${cid}\n` : '') + details, cid, d);
      }
      break;
    }
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

// Duree de conservation par table (jours) ; les logs et mesures de perf, tres volumineux, sont gardes moins longtemps.
const RETENTION = {
  server_logs: parseInt(process.env.RETENTION_LOGS_DAYS || '30', 10),
  perf_metrics: parseInt(process.env.RETENTION_PERF_DAYS || '90', 10),
  player_snapshots: parseInt(process.env.RETENTION_SNAPSHOTS_DAYS || '180', 10),
};
async function purgeOld() {
  for (const t of ['events', 'server_logs', 'perf_metrics', 'player_snapshots', 'economy_snapshots', 'vehicles_owned', 'alerts', 'db_table_stats', 'commands']) {
    const days = RETENTION[t] || RETENTION_DAYS;
    // Par paquets de 50 000 lignes pour ne pas bloquer la base.
    for (let i = 0; i < 400; i++) {
      const r = await q(`DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ts < now() - make_interval(days => $1) LIMIT 50000)`, [days]);
      if ((r.rowCount || 0) < 50000) break;
    }
  }
}

// Index utiles aux vues du panel, crees en arriere-plan (CONCURRENTLY) pour ne jamais bloquer l'ingestion.
async function ensureIndexes() {
  for (const sql of [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_subtype_ts ON events (subtype, ts DESC)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_flow_from ON events ((data->>'from_cid'), ts DESC) WHERE subtype = 'bank_flow'`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_flow_to ON events ((data->>'to_cid'), ts DESC) WHERE subtype = 'bank_flow'`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slogs_level_ts ON server_logs (level, ts DESC)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deaths_killer ON deaths (killer_cid, ts DESC)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_license ON sessions (license)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_cid ON alerts (citizenid, ts DESC)`,
  ]) await q(sql);
  console.log('Index OK');
}

// Taille de tranche (s) pour renvoyer ~600 points par courbe au lieu de milliers.
const bucketSec = (hours, min = 15) => Math.max(min, Math.round(hours * 3600 / 600));

/* -------------------------------- alertes -------------------------------- */

const SEVERITY_COLOR = { critical: 0xf43f5e, warn: 0xfbbf24, info: 0x8b7bff, ok: 0x34d399 };
const fmtMoney = (v) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(v) || 0)) + ' $';
const stripColors = (s) => String(s ?? '').replace(/\^\d/g, '');

async function notifyDiscord(alert) {
  if (!DISCORD_WEBHOOK_URL) return false;
  try {
    const r = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Brothers Life — Panel',
        embeds: [{
          title: alert.title.slice(0, 250),
          description: (alert.detail || '').slice(0, 2000),
          color: SEVERITY_COLOR[alert.severity] || SEVERITY_COLOR.warn,
          timestamp: new Date().toISOString(),
          footer: { text: alert.kind },
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch (e) {
    console.error('discord:', e.message);
    return false;
  }
}

async function raiseAlert(kind, severity, title, detail, citizenid = null, data = {}) {
  const r = await q('INSERT INTO alerts (kind, severity, title, detail, citizenid, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [kind, severity, title, detail, citizenid, JSON.stringify(data)]);
  const id = r.rows[0]?.id;
  if (id && await notifyDiscord({ kind, severity, title, detail })) await q('UPDATE alerts SET notified = true WHERE id = $1', [id]);
}

const alertState = { serverDown: null, lastErrorBurst: 0, lastLogId: null, lastMoneyCheck: null, moneyCooldown: new Map() };

async function checkAlerts() {
  // 1) Serveur tombé / revenu : deux relevés consécutifs pour confirmer
  const up = await q(`SELECT value FROM perf_metrics WHERE metric='server_up' ORDER BY ts DESC LIMIT 2`);
  if (up.rows.length === 2) {
    const down = up.rows.every((r) => Number(r.value) === 0);
    const back = Number(up.rows[0].value) === 1;
    if (alertState.serverDown === null) alertState.serverDown = down;
    else if (down && !alertState.serverDown) {
      alertState.serverDown = true;
      await raiseAlert('server_down', 'critical', 'Serveur injoignable', 'Le serveur FiveM ne répond plus aux deux derniers relevés.');
    } else if (back && alertState.serverDown) {
      alertState.serverDown = false;
      await raiseAlert('server_up', 'ok', 'Serveur de nouveau en ligne', 'Le serveur FiveM répond à nouveau.');
    }
  }

  // 2) Rafale d'erreurs console (cooldown 15 min)
  if (Date.now() - alertState.lastErrorBurst > 15 * 60e3) {
    const e = await q(`SELECT COUNT(*)::int AS n, (array_agg(DISTINCT channel))[1:5] AS channels FROM server_logs WHERE level='error' AND ts > now() - interval '5 minutes'`);
    const n = e.rows[0]?.n || 0;
    if (n >= ALERT_ERRORS_5MIN) {
      alertState.lastErrorBurst = Date.now();
      await raiseAlert('error_burst', 'warn', `${n} erreurs console en 5 minutes`, 'Canaux : ' + (e.rows[0].channels || []).filter(Boolean).join(', '), null, { n });
    }
  }

  // 3) Anticheat : nouvelles lignes warn/error sur le canal anticheat
  if (alertState.lastLogId === null) {
    alertState.lastLogId = Number((await q('SELECT COALESCE(MAX(id),0) AS id FROM server_logs')).rows[0]?.id || 0);
  } else {
    const ac = await q(`SELECT id, ts, channel, level, line FROM server_logs WHERE id > $1 AND channel ILIKE $2 AND level IN ('warn','error') ORDER BY id LIMIT 50`,
      [alertState.lastLogId, '%' + ALERT_ANTICHEAT_CHANNEL + '%']);
    const maxId = await q('SELECT COALESCE(MAX(id),0) AS id FROM server_logs');
    alertState.lastLogId = Number(maxId.rows[0]?.id || alertState.lastLogId);
    const lines = ac.rows.map((r) => stripColors(r.line).trim());
    if (lines.length === 1) await raiseAlert('anticheat', 'critical', 'Anticheat', lines[0]);
    else if (lines.length > 1) await raiseAlert('anticheat', 'critical', `Anticheat : ${lines.length} détections`, lines.slice(0, 8).map((l) => '• ' + l.slice(0, 200)).join('\n'), null, { n: lines.length });
  }

  // 4) Saut d'argent anormal entre deux snapshots d'un même joueur (cooldown 30 min / joueur)
  const since = alertState.lastMoneyCheck || new Date(Date.now() - ALERT_INTERVAL_MS);
  alertState.lastMoneyCheck = new Date();
  const jumps = await q(`
    WITH s AS (
      SELECT citizenid, name, ts, COALESCE(cash,0)+COALESCE(bank,0) AS total,
             lag(COALESCE(cash,0)+COALESCE(bank,0)) OVER (PARTITION BY citizenid ORDER BY ts) AS prev
      FROM player_snapshots WHERE ts > $1::timestamptz - interval '2 hours')
    SELECT citizenid, name, ts, prev, total, total - prev AS jump FROM s
    WHERE ts > $1 AND prev IS NOT NULL AND total - prev >= $2 ORDER BY jump DESC LIMIT 20`, [since, ALERT_MONEY_JUMP]);
  for (const j of jumps.rows) {
    const last = alertState.moneyCooldown.get(j.citizenid) || 0;
    if (Date.now() - last < 30 * 60e3) continue;
    alertState.moneyCooldown.set(j.citizenid, Date.now());
    await raiseAlert('money_jump', 'warn', `Saut d'argent : ${j.name || j.citizenid} +${fmtMoney(j.jump)}`,
      `${fmtMoney(j.prev)} → ${fmtMoney(j.total)} (citizenid ${j.citizenid})`, j.citizenid, { prev: j.prev, total: j.total, jump: j.jump });
  }
}

/* ------------------------------ temps reel (SSE) ------------------------------ */

const streamClients = new Set();
const streamCursor = { log: null, chat: null, session: null, death: null, alert: null };
let streamTimer = null;

async function maxId(table) { return Number((await q(`SELECT COALESCE(MAX(id),0) AS id FROM ${table}`)).rows[0]?.id || 0); }

async function streamTick() {
  if (!streamClients.size) return;
  const c = streamCursor;
  if (c.log === null) {
    [c.log, c.chat, c.session, c.death, c.alert] = await Promise.all(['server_logs', 'events', 'sessions', 'deaths', 'alerts'].map(maxId));
  }
  // Les events (chat) avancent vite : on borne par le max global pour ne pas re-scanner ni rater de ligne
  const lastEvent = await maxId('events');
  const [logs, chat, sessions, deaths, alerts, status] = await Promise.all([
    q('SELECT id, ts, channel, level, line FROM server_logs WHERE id > $1 ORDER BY id LIMIT 100', [c.log]),
    q(`SELECT id, ts, player_name, citizenid, subtype, data->>'message' AS message FROM events WHERE id > $1 AND id <= $2 AND subtype IN ('chat','command') ORDER BY id LIMIT 100`, [c.chat, lastEvent]),
    q('SELECT id, start_ts AS ts, player_name, citizenid FROM sessions WHERE id > $1 ORDER BY id LIMIT 50', [c.session]),
    q('SELECT id, ts, player_name, citizenid, cause, killer_name, weapon FROM deaths WHERE id > $1 ORDER BY id LIMIT 50', [c.death]),
    q('SELECT id, ts, kind, severity, title, detail FROM alerts WHERE id > $1 ORDER BY id LIMIT 20', [c.alert]),
    q(`SELECT (SELECT value FROM perf_metrics WHERE metric='players_online' ORDER BY ts DESC LIMIT 1) AS online,
              (SELECT value FROM perf_metrics WHERE metric='players_max' ORDER BY ts DESC LIMIT 1) AS max,
              (SELECT value FROM perf_metrics WHERE metric='server_up' ORDER BY ts DESC LIMIT 1) AS up`),
  ]);
  if (logs.rows.length) c.log = Number(logs.rows[logs.rows.length - 1].id);
  c.chat = chat.rows.length === 100 ? Number(chat.rows[99].id) : lastEvent;
  if (sessions.rows.length) c.session = Number(sessions.rows[sessions.rows.length - 1].id);
  if (deaths.rows.length) c.death = Number(deaths.rows[deaths.rows.length - 1].id);
  if (alerts.rows.length) c.alert = Number(alerts.rows[alerts.rows.length - 1].id);
  const payload = 'event: tick\ndata: ' + JSON.stringify({
    status: status.rows[0] || {}, logs: logs.rows, chat: chat.rows, sessions: sessions.rows, deaths: deaths.rows, alerts: alerts.rows,
  }) + '\n\n';
  for (const res of streamClients) res.write(payload);
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  });
  res.write('retry: 5000\n: ok\n\n');
  streamClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  if (!streamTimer) {
    const tick = () => streamTick().catch((e) => console.error('stream:', e.message));
    tick(); // fixe les curseurs tout de suite
    streamTimer = setInterval(tick, 3000);
  }
  req.on('close', () => {
    clearInterval(ping);
    streamClients.delete(res);
    if (!streamClients.size) { clearInterval(streamTimer); streamTimer = null; Object.keys(streamCursor).forEach((k) => { streamCursor[k] = null; }); }
  });
}

/* ------------------------------- API stats ------------------------------- */

function hoursParam(url, def) {
  const h = parseInt(new URL(url, 'http://x').searchParams.get('h') || String(def), 10);
  return Math.min(Math.max(h || def, 1), 24 * 90);
}

const api = {
  async overview(url) {
    const h = hoursParam(url, 24);
    const b = bucketSec(h);
    const [online, tick, counts, errors, up] = await Promise.all([
      q(`SELECT floor(extract(epoch FROM ts) / ${b}) * ${b} * 1000 AS t, ROUND(AVG(value)::numeric, 1) AS value FROM perf_metrics
         WHERE metric='players_online' AND ts > now() - interval '${h} hours' GROUP BY 1 ORDER BY 1`),
      q(`SELECT floor(t / 1000 / ${b}) * ${b} * 1000 AS t, thread, AVG(ms) AS ms FROM (WITH s AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric='tick_sum_sec' AND ts > now() - interval '${h} hours'),
               c AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric='tick_count' AND ts > now() - interval '${h} hours')
         SELECT extract(epoch FROM s.ts)*1000 AS t, s.thread,
                (s.v - lag(s.v) OVER (PARTITION BY s.thread ORDER BY s.ts)) / NULLIF(c.v - lag(c.v) OVER (PARTITION BY c.thread ORDER BY c.ts),0) * 1000 AS ms
         FROM s JOIN c ON c.ts = s.ts AND c.thread = s.thread) x WHERE ms IS NOT NULL GROUP BY 1, 2 ORDER BY 1`),
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
    const [mass, top, shops, purchases, flows, flowsByHour, latest, extra] = await Promise.all([
      q(`SELECT floor(extract(epoch FROM ts) / ${bucketSec(h, 60)}) * ${bucketSec(h, 60)} * 1000 AS t, AVG(total_cash) AS total_cash, AVG(total_bank) AS total_bank
         FROM economy_snapshots WHERE ts > now() - interval '${h} hours' GROUP BY 1 ORDER BY 1`),
      q(`SELECT name, citizenid, cash, bank, cash+bank AS total FROM (SELECT DISTINCT ON (citizenid) citizenid, name, cash, bank FROM player_snapshots ORDER BY citizenid, ts DESC) t ORDER BY total DESC NULLS LAST LIMIT 20`),
      q(`SELECT COALESCE(shop,'?') AS shop, SUM(total) AS ca, COUNT(*) AS n FROM purchases WHERE ts > now() - interval '${h} hours' GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 15`),
      q(`SELECT ts, player_name, citizenid, shop, COALESCE(label,item) AS article, qty, total, currency FROM purchases ORDER BY ts DESC LIMIT 100`),
      q(`SELECT ts, data->>'kind' AS kind, data->>'from_cid' AS from_cid, data->>'to_cid' AS to_cid, (data->>'amount')::numeric AS amount, data->>'note' AS note FROM events WHERE subtype='bank_flow' ORDER BY ts DESC LIMIT 100`),
      q(`SELECT date_trunc('hour', ts) AS t, COALESCE(data->>'kind','?') AS kind, SUM((data->>'amount')::numeric) AS total FROM events WHERE subtype='bank_flow' AND ts > now() - interval '${h} hours' GROUP BY 1,2 ORDER BY 1`),
      q(`SELECT ts, player_count, chars_total, total_cash, total_bank, total_crypto, society_total FROM economy_snapshots ORDER BY ts DESC LIMIT 1`),
      q(`SELECT extract(epoch FROM date_trunc('hour', ts))*1000 AS t, AVG(total_crypto) AS crypto, AVG(society_total) AS society FROM economy_snapshots WHERE ts > now() - interval '${h} hours' GROUP BY 1 ORDER BY 1`),
    ]);
    return { mass: mass.rows, top: top.rows, shops: shops.rows, purchases: purchases.rows, flows: flows.rows, flowsByHour: flowsByHour.rows, latest: latest.rows[0] || {}, extra: extra.rows };
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
      q('SELECT ts, cause, killer_name, killer_cid, weapon, x, y, z, screenshot_url FROM deaths WHERE citizenid=$1 ORDER BY ts DESC LIMIT 50', [cid]),
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
  async db() {
    const [snaps, tables, day, week] = await Promise.all([
      q(`SELECT name, label, kind, pos, ts, columns, rows FROM db_snapshots ORDER BY pos NULLS LAST, name`),
      q(`SELECT ts, rows FROM db_snapshots WHERE name = '_tables'`),
      q(`SELECT DISTINCT ON (table_name) table_name, rows FROM db_table_stats WHERE ts <= now() - interval '24 hours' ORDER BY table_name, ts DESC`),
      q(`SELECT DISTINCT ON (table_name) table_name, rows FROM db_table_stats WHERE ts <= now() - interval '7 days' ORDER BY table_name, ts DESC`),
    ]);
    const before = (list) => Object.fromEntries(list.rows.map((r) => [r.table_name, Number(r.rows)]));
    const d1 = before(day), d7 = before(week);
    const t = tables.rows[0];
    return {
      tablesTs: t?.ts || null,
      tables: (t?.rows || []).map(([name, rows, bytes]) => ({ name, rows: Number(rows) || 0, bytes: Number(bytes) || 0, rows24h: d1[name] ?? null, rows7d: d7[name] ?? null })),
      snapshots: snaps.rows.filter((r) => !r.name.startsWith('_') && !['hidden', 'internal'].includes(r.kind)),
    };
  },
  async deathmap(url) {
    const h = hoursParam(url, 24 * 7);
    const [points, shots] = await Promise.all([
      q(`SELECT ts, citizenid, player_name, cause, killer_cid, killer_name, weapon, x, y, z, screenshot_url
         FROM deaths WHERE x IS NOT NULL AND y IS NOT NULL AND ts > now() - interval '${h} hours' ORDER BY ts DESC LIMIT 5000`),
      q(`SELECT ts, citizenid, player_name, cause, killer_name, weapon, screenshot_url FROM deaths WHERE screenshot_url IS NOT NULL AND screenshot_url <> '' ORDER BY ts DESC LIMIT 40`),
    ]);
    return { points: points.rows, screenshots: shots.rows };
  },
  async anomalies(url) {
    const p = new URL(url, 'http://x').searchParams;
    const h = hoursParam(url, 24);
    const min = Math.max(0, parseInt(p.get('min') || String(ALERT_MONEY_JUMP), 10) || 0);
    const r = await q(`
      WITH s AS (
        SELECT citizenid, name, ts, COALESCE(cash,0)+COALESCE(bank,0) AS total,
               lag(COALESCE(cash,0)+COALESCE(bank,0)) OVER (PARTITION BY citizenid ORDER BY ts) AS prev,
               first_value(COALESCE(cash,0)+COALESCE(bank,0)) OVER (PARTITION BY citizenid ORDER BY ts) AS first_total,
               row_number() OVER (PARTITION BY citizenid ORDER BY ts DESC) AS rn
        FROM player_snapshots WHERE ts > now() - interval '${h} hours'),
      j AS (SELECT DISTINCT ON (citizenid) citizenid, name, ts, prev, total, total - prev AS jump
            FROM s WHERE prev IS NOT NULL ORDER BY citizenid, total - prev DESC),
      n AS (SELECT citizenid, first_total, total AS last_total FROM s WHERE rn = 1)
      SELECT j.citizenid, j.name, j.ts, j.prev, j.total, j.jump, n.first_total, n.last_total, n.last_total - n.first_total AS net
      FROM j JOIN n USING (citizenid) WHERE j.jump >= $1 ORDER BY j.jump DESC LIMIT 100`, [min]);
    return { min, hours: h, players: r.rows };
  },
  async alerts() {
    const [list, byKind] = await Promise.all([
      q('SELECT id, ts, kind, severity, title, detail, citizenid, notified FROM alerts ORDER BY ts DESC LIMIT 200'),
      q(`SELECT kind, COUNT(*)::int AS n FROM alerts WHERE ts > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return {
      alerts: list.rows, byKind: byKind.rows,
      config: { discord: !!DISCORD_WEBHOOK_URL, errors5min: ALERT_ERRORS_5MIN, moneyJump: ALERT_MONEY_JUMP, anticheatChannel: ALERT_ANTICHEAT_CHANNEL },
    };
  },
  async insights(url) {
    const d = Math.min(Math.max(parseInt(new URL(url, 'http://x').searchParams.get('d') || '7', 10) || 7, 1), 90);
    const tz = PANEL_TZ.replace(/[^A-Za-z_/+-]/g, '');
    const [heat, jobs, gangs, killers, weapons, causes, peak, uptime] = await Promise.all([
      q(`SELECT extract(isodow FROM ts AT TIME ZONE '${tz}')::int AS dow, extract(hour FROM ts AT TIME ZONE '${tz}')::int AS hour,
                ROUND(AVG(value)::numeric, 1) AS avg, MAX(value) AS max
         FROM perf_metrics WHERE metric='players_online' AND ts > now() - interval '${d} days' GROUP BY 1,2`),
      q(`SELECT COALESCE(NULLIF(job,''),'aucun') AS name, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE online))::int AS online
         FROM (SELECT DISTINCT ON (citizenid) job, online FROM player_snapshots ORDER BY citizenid, ts DESC) t GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      q(`SELECT gang AS name, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE online))::int AS online
         FROM (SELECT DISTINCT ON (citizenid) gang, online FROM player_snapshots ORDER BY citizenid, ts DESC) t
         WHERE gang IS NOT NULL AND gang NOT IN ('', 'none') GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      q(`SELECT killer_name AS name, MAX(killer_cid) AS citizenid, COUNT(*)::int AS n FROM deaths
         WHERE killer_name IS NOT NULL AND killer_name <> '' AND ts > now() - interval '${d} days' GROUP BY 1 ORDER BY 3 DESC LIMIT 10`),
      q(`SELECT weapon AS name, COUNT(*)::int AS n FROM deaths WHERE weapon IS NOT NULL AND weapon <> '' AND ts > now() - interval '${d} days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT COALESCE(NULLIF(cause,''),'?') AS name, COUNT(*)::int AS n FROM deaths WHERE ts > now() - interval '${d} days' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT value AS n, ts FROM perf_metrics WHERE metric='players_online' AND ts > now() - interval '${d} days' ORDER BY value DESC, ts DESC LIMIT 1`),
      q(`SELECT ROUND((100 * AVG(value) FILTER (WHERE ts > now() - interval '24 hours'))::numeric, 2) AS day,
                ROUND((100 * AVG(value))::numeric, 2) AS period
         FROM perf_metrics WHERE metric='server_up' AND ts > now() - interval '${d} days'`),
    ]);
    return { days: d, tz, heat: heat.rows, jobs: jobs.rows, gangs: gangs.rows, killers: killers.rows, weapons: weapons.rows, causes: causes.rows, peak: peak.rows[0] || null, uptime: uptime.rows[0] || {} };
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

const panelUsers = require('./panel-users')({ q, json, readBody });
const features = require('./features')({ q, json, readBody, tz: PANEL_TZ });
Object.assign(api, features.api);
if (!PANEL_API_KEY) console.warn('[api] PANEL_API_KEY absente : les routes /api/* sont PUBLIQUES.');

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, lastScrapeOk });

    if (req.method === 'POST' && url === '/v1/batch') {
      if (!ingestAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
      const raw = await readBody(req);
      const batch = JSON.parse(raw.toString('utf8'));
      const out = await handleBatch(batch);
      // bl_telemetry 1.3+ : résultats des annonces dans le lot, nouvelles annonces dans la réponse (?commands=1).
      if (Array.isArray(batch.acks)) for (const a of batch.acks.slice(0, 50)) await features.commands.ack(a.id, a.ok, a.result);
      if (/[?&]commands=1\b/.test(req.url)) out.commands = await features.commands.pull();
      return json(res, 200, out);
    }

    // Ordres du panel (annonces) relevés par bl_telemetry.
    if (url.startsWith('/v1/commands')) {
      if (!ingestAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (await features.handleFivem(req, res, url)) return;
      return json(res, 404, { error: 'inconnu' });
    }

    if (url.startsWith('/api/')) {
      if (!panelAuthorized(req)) return json(res, 401, { error: 'réservé au panel' });
      if (url === '/api/panel-users' || url.startsWith('/api/panel-users/')) return panelUsers(req, res, url);
      if (await features.handlePanel(req, res, url)) return;
    }

    if (req.method === 'GET' && url === '/api/stream') return openStream(req, res);

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
  ensureIndexes().catch((e) => console.error('index:', e.message));
  setTimeout(() => purgeOld().catch((e) => console.error('purge:', e.message)), 60e3);
  setInterval(() => purgeOld().catch((e) => console.error('purge:', e.message)), 24 * 3600 * 1000);
  setInterval(() => checkAlerts().catch((e) => console.error('alerts:', e.message)), ALERT_INTERVAL_MS);
}).catch((e) => { console.error('init failed:', e); process.exit(1); });
