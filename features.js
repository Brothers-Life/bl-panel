'use strict';
/*
 * Vues avancées du panel :
 *   GET  /api/timeline?cid=&before=     journal complet d'un joueur
 *   GET  /api/linked?cid=               personnages liés (même licence, jamais affichée)
 *   GET  /api/search?q=&days=           recherche globale (joueurs, logs, chat, événements)
 *   GET  /api/trace?cid=&ts=            origine d'un saut d'argent
 *   GET  /api/inflation?d=              masse monétaire par jour, flux par type, fortune médiane
 *   GET  /api/scripts                   erreurs par ressource, ralentissements, état des ressources
 *   GET  /api/commands, POST /api/commands   annonces envoyées au serveur (exécutées par bl_telemetry)
 * Côté FiveM (jeton INGEST_TOKEN) : GET /v1/commands, POST /v1/commands/:id/ack
 */

module.exports = function createFeatures({ q, json, readBody, tz }) {
  const params = (url) => new URL(url, 'http://x').searchParams;
  const clampInt = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);
  const body = async (req) => { try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return null; } };
  const TZ = String(tz || 'Europe/Paris').replace(/[^A-Za-z_/+-]/g, '');
  const NOISE = `('player_snapshot','vehicle_snapshot','economy_snapshot','db_snapshot','death','purchase','session_start','session_end')`;

  async function timeline(url) {
    const p = params(url);
    const cid = (p.get('cid') || '').slice(0, 60);
    if (!cid) return { error: 'cid requis' };
    const before = p.get('before') ? new Date(p.get('before')) : new Date(Date.now() + 60e3);
    const limit = clampInt(p.get('limit'), 200, 20, 500);
    const r = await q(`
      SELECT ts, kind, data FROM (
        SELECT start_ts AS ts, 'session_start' AS kind, '{}'::jsonb AS data FROM sessions WHERE citizenid = $1
        UNION ALL SELECT end_ts, 'session_end', jsonb_build_object('reason', drop_reason, 'minutes', ROUND(duration_min::numeric)) FROM sessions WHERE citizenid = $1 AND end_ts IS NOT NULL
        UNION ALL SELECT ts, 'death', jsonb_build_object('cause', cause, 'killer', killer_name, 'killer_cid', killer_cid, 'weapon', weapon, 'x', x, 'y', y, 'screenshot_url', screenshot_url) FROM deaths WHERE citizenid = $1
        UNION ALL SELECT ts, 'kill', jsonb_build_object('victim', player_name, 'victim_cid', citizenid, 'weapon', weapon) FROM deaths WHERE killer_cid = $1
        UNION ALL SELECT ts, 'purchase', jsonb_build_object('shop', shop, 'article', COALESCE(label, item), 'qty', qty, 'total', total) FROM purchases WHERE citizenid = $1
        UNION ALL SELECT ts, 'bank_flow', data FROM events WHERE subtype = 'bank_flow' AND (data->>'from_cid' = $1 OR data->>'to_cid' = $1)
        UNION ALL SELECT ts, COALESCE(subtype, type), data FROM events
          WHERE citizenid = $1 AND type NOT IN ${NOISE} AND COALESCE(subtype, '') <> 'bank_flow'
        UNION ALL SELECT ts, 'alert', jsonb_build_object('title', title, 'kind', kind, 'severity', severity) FROM alerts WHERE citizenid = $1
      ) t WHERE ts IS NOT NULL AND ts < $2 ORDER BY ts DESC LIMIT $3`, [cid, before, limit]);
    return { cid, items: r.rows };
  }

  async function linked(url) {
    const cid = (params(url).get('cid') || '').slice(0, 60);
    if (!cid) return { error: 'cid requis' };
    const [map, sess] = await Promise.all([
      q(`SELECT rows FROM db_snapshots WHERE name = 'license_map'`),
      q(`SELECT DISTINCT s2.citizenid, s2.player_name FROM sessions s1 JOIN sessions s2 ON s2.license = s1.license
         WHERE s1.citizenid = $1 AND s1.license IS NOT NULL AND s2.citizenid IS NOT NULL AND s2.citizenid <> $1`, [cid]),
    ]);
    const out = new Map();
    const rows = map.rows[0]?.rows || [];
    const mine = rows.find((r) => r[0] === cid);
    if (mine) for (const r of rows) if (r[1] === mine[1] && r[0] !== cid) out.set(r[0], { citizenid: r[0], name: r[2], via: 'même licence' });
    for (const s of sess.rows) if (!out.has(s.citizenid)) out.set(s.citizenid, { citizenid: s.citizenid, name: s.player_name, via: 'connexions' });
    return { cid, known: !!mine, players: [...out.values()] };
  }

  async function search(url) {
    const p = params(url);
    const term = (p.get('q') || '').trim().slice(0, 100);
    if (term.length < 2) return { error: 'au moins 2 caractères' };
    const days = clampInt(p.get('days'), 7, 1, 90);
    const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const [players, logs, chat, events] = await Promise.all([
      q(`SELECT DISTINCT ON (citizenid) citizenid, name, job, gang, online, ts FROM player_snapshots
         WHERE name ILIKE $1 OR citizenid ILIKE $1 ORDER BY citizenid, ts DESC LIMIT 30`, [like]),
      q(`SELECT ts, channel, level, line FROM server_logs WHERE ts > now() - make_interval(days => $2) AND line ILIKE $1 ORDER BY ts DESC LIMIT 150`, [like, days]),
      q(`SELECT ts, citizenid, player_name, subtype, data->>'message' AS message FROM events
         WHERE subtype IN ('chat', 'command') AND ts > now() - make_interval(days => $2) AND (data->>'message' ILIKE $1 OR player_name ILIKE $1)
         ORDER BY ts DESC LIMIT 100`, [like, days]),
      q(`SELECT ts, type, subtype, citizenid, player_name, data FROM events
         WHERE ts > now() - make_interval(days => $2) AND type NOT IN ${NOISE} AND COALESCE(subtype, '') NOT IN ('chat', 'command')
           AND (data::text ILIKE $1 OR player_name ILIKE $1 OR citizenid ILIKE $1)
         ORDER BY ts DESC LIMIT 150`, [like, days]),
    ]);
    return { q: term, days, players: players.rows, logs: logs.rows, chat: chat.rows, events: events.rows };
  }

  async function trace(url) {
    const p = params(url);
    const cid = (p.get('cid') || '').slice(0, 60);
    const at = new Date(p.get('ts') || Date.now());
    if (!cid || isNaN(at)) return { error: 'cid et ts requis' };
    const win = clampInt(p.get('min'), 30, 5, 720);
    const from = new Date(at.getTime() - win * 60e3), to = new Date(at.getTime() + 5 * 60e3);
    const [before, after, flows, purchases, events, staff] = await Promise.all([
      q(`SELECT ts, cash, bank FROM player_snapshots WHERE citizenid = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1`, [cid, at]),
      q(`SELECT ts, cash, bank FROM player_snapshots WHERE citizenid = $1 AND ts >= $2 ORDER BY ts LIMIT 1`, [cid, at]),
      q(`SELECT ts, data FROM events WHERE subtype = 'bank_flow' AND ts BETWEEN $2 AND $3 AND (data->>'from_cid' = $1 OR data->>'to_cid' = $1) ORDER BY ts`, [cid, from, to]),
      q(`SELECT ts, shop, COALESCE(label, item) AS article, qty, total FROM purchases WHERE citizenid = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`, [cid, from, to]),
      q(`SELECT ts, type, subtype, data FROM events WHERE citizenid = $1 AND ts BETWEEN $2 AND $3 AND type NOT IN ${NOISE}
           AND COALESCE(subtype, '') NOT IN ('bank_flow', 'chat') ORDER BY ts`, [cid, from, to]),
      q(`SELECT ts, data FROM events WHERE type = 'admin_action' AND ts BETWEEN $2 AND $3 AND data::text ILIKE $1 ORDER BY ts`, ['%' + cid + '%', from, to]),
    ]);
    return { cid, at, windowMin: win, before: before.rows[0] || null, after: after.rows[0] || null, flows: flows.rows, purchases: purchases.rows, events: events.rows, staff: staff.rows };
  }

  async function inflation(url) {
    const d = clampInt(params(url).get('d'), 30, 7, 365);
    const [days, flows, median] = await Promise.all([
      q(`SELECT day, cash, bank, chars, players FROM (
           SELECT DISTINCT ON (date_trunc('day', ts AT TIME ZONE '${TZ}')) date_trunc('day', ts AT TIME ZONE '${TZ}') AS day,
                  total_cash AS cash, total_bank AS bank, chars_total AS chars, player_count AS players
           FROM economy_snapshots WHERE ts > now() - make_interval(days => $1)
           ORDER BY date_trunc('day', ts AT TIME ZONE '${TZ}'), ts DESC) t ORDER BY day`, [d]),
      q(`SELECT date_trunc('day', ts AT TIME ZONE '${TZ}') AS day, COALESCE(data->>'kind', '?') AS kind,
                SUM((data->>'amount')::numeric) AS total, COUNT(*)::int AS n
         FROM events WHERE subtype = 'bank_flow' AND ts > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 1`, [d]),
      q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY w) AS median, AVG(w) AS mean, COUNT(*)::int AS n FROM (
           SELECT DISTINCT ON (citizenid) COALESCE(cash, 0) + COALESCE(bank, 0) AS w FROM player_snapshots ORDER BY citizenid, ts DESC) t`),
    ]);
    return { days: d, daily: days.rows, flows: flows.rows, wealth: median.rows[0] || {} };
  }

  const HITCH = /(\d+(?:\.\d+)?)\s*(?:ms|milliseconds)/i;
  async function scripts() {
    const [counts, lastErr, hitches, res, starts] = await Promise.all([
      q(`SELECT COALESCE(channel, '?') AS channel, level, COUNT(*)::int AS n, MAX(ts) AS last FROM server_logs
         WHERE ts > now() - interval '24 hours' AND level IN ('error', 'warn') AND COALESCE(line, '') NOT ILIKE '%hitch warning%'
         GROUP BY 1, 2`),
      q(`SELECT DISTINCT ON (channel) channel, ts, line FROM server_logs WHERE ts > now() - interval '24 hours' AND level = 'error'
         ORDER BY channel, ts DESC`),
      q(`SELECT ts, line FROM server_logs WHERE ts > now() - interval '24 hours' AND line ILIKE '%hitch warning%' ORDER BY ts DESC LIMIT 5000`),
      q(`SELECT ts, rows FROM db_snapshots WHERE name = '_resources'`),
      q(`SELECT ts FROM events WHERE subtype = 'server_start' AND ts > now() - interval '30 days' ORDER BY ts DESC LIMIT 50`),
    ]);
    const by = new Map();
    for (const r of counts.rows) {
      const e = by.get(r.channel) || { channel: r.channel, errors: 0, warns: 0, last: null, lastError: null };
      if (r.level === 'error') e.errors = r.n; else e.warns = r.n;
      if (!e.last || r.last > e.last) e.last = r.last;
      by.set(r.channel, e);
    }
    for (const r of lastErr.rows) { const e = by.get(r.channel); if (e) e.lastError = { ts: r.ts, line: String(r.line || '').slice(0, 400) }; }
    const hours = new Map();
    for (const h of hitches.rows) {
      const ms = Number((HITCH.exec(h.line || '') || [])[1]) || 0;
      const k = new Date(h.ts); k.setMinutes(0, 0, 0);
      const b = hours.get(+k) || { t: +k, n: 0, max: 0, total: 0 };
      b.n++; b.max = Math.max(b.max, ms); b.total += ms;
      hours.set(+k, b);
    }
    return {
      resources: [...by.values()].sort((a, b) => b.errors - a.errors || b.warns - a.warns),
      hitches: { count: hitches.rows.length, hours: [...hours.values()].sort((a, b) => a.t - b.t), worst: Math.max(0, ...[...hours.values()].map((b) => b.max)) },
      list: res.rows[0] ? { ts: res.rows[0].ts, rows: res.rows[0].rows } : null,
      restarts: starts.rows.map((r) => r.ts),
    };
  }

  /* ------------------------------- annonces ------------------------------- */
  async function listCommands() {
    const r = await q(`SELECT id, ts, type, payload, author, status, sent_at, done_at, result FROM commands ORDER BY id DESC LIMIT 50`);
    return { commands: r.rows };
  }
  async function createCommand(req, res) {
    const b = await body(req);
    if (!b || b.type !== 'announce') return json(res, 400, { error: 'ordre inconnu' });
    const p = b.payload || {};
    const message = String(p.message || '').trim().slice(0, 500);
    if (!message) return json(res, 400, { error: 'message vide' });
    const payload = {
      message, title: String(p.title || 'Annonce').slice(0, 60),
      mode: ['chat', 'notify', 'both'].includes(p.mode) ? p.mode : 'both',
      type: ['inform', 'success', 'warning', 'error'].includes(p.type) ? p.type : 'inform',
      duration: clampInt(p.duration, 10000, 3000, 60000),
    };
    const r = await q(`INSERT INTO commands (type, payload, author) VALUES ('announce', $1, $2) RETURNING id`, [JSON.stringify(payload), String(b.author || '?').slice(0, 80)]);
    return json(res, 200, { ok: true, id: r.rows[0]?.id });
  }

  // FiveM : récupère les ordres en attente (les plus vieux de 10 min expirent).
  async function pullCommands(res) {
    await q(`UPDATE commands SET status = 'expired' WHERE status = 'pending' AND ts < now() - interval '10 minutes'`);
    const r = await q(`UPDATE commands SET status = 'sent', sent_at = now()
                       WHERE id IN (SELECT id FROM commands WHERE status = 'pending' ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
                       RETURNING id, type, payload`);
    return json(res, 200, { commands: r.rows });
  }
  async function ackCommand(req, res, id) {
    const b = (await body(req)) || {};
    await q(`UPDATE commands SET status = $2, done_at = now(), result = $3 WHERE id = $1 AND status = 'sent'`,
      [id, b.ok ? 'done' : 'failed', String(b.result || '').slice(0, 300)]);
    return json(res, 200, { ok: true });
  }

  return {
    api: { timeline, linked, search, trace, inflation, scripts },
    // Routes panel avec méthode (POST) : renvoie true si traitée.
    async handlePanel(req, res, url) {
      if (url !== '/api/commands') return false;
      if (req.method === 'POST') await createCommand(req, res); else json(res, 200, await listCommands());
      return true;
    },
    // Routes FiveM (jeton déjà vérifié).
    async handleFivem(req, res, url) {
      if (url === '/v1/commands' && req.method === 'GET') { await pullCommands(res); return true; }
      const m = /^\/v1\/commands\/(\d+)\/ack$/.exec(url);
      if (m && req.method === 'POST') { await ackCommand(req, res, m[1]); return true; }
      return false;
    },
  };
};
