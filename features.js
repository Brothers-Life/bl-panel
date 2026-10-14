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
 *   GET  /api/staff?days=&staff=&cat=&q=     qui fait quoi : actions staff (txAdmin, tables d'admin du jeu, panel)
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

  /* ------------------------------- suivi staff ------------------------------- */
  // Tables du jeu qui journalisent des actions staff (suivies par bl_telemetry/live.lua).
  const STAFF_TABLES = ['admindash_audit_log', 'admindash_sanctions', 'admindash_role_actions', 'admindash_staff_sessions',
    'admindash_blip_logs', 'admindash_staff_loans', 'teleport_admin_logs', 'garage_admin_logs', 'job_admin_logs', 'shop_admin_logs',
    'shop_admin', 'mapeditor_audit', 'dj_audit', 'tv_admin_logs', 'qbx_vehicle_admin_probe', 'bl_safezones_audit', 'mdt_audit'];
  const ACTOR_KEYS = ['admin_name', 'admin', 'staff', 'staff_name', 'author', 'by', 'executor', 'moderator', 'bannedby', 'banned_by',
    'created_by', 'actor', 'admin_label', 'officer', 'officer_name', 'user', 'username'];
  const ACTION_KEYS = ['action', 'type', 'event', 'command', 'category', 'kind', 'log_type', 'what'];
  const TARGET_KEYS = ['target_name', 'target', 'target_label', 'player_name', 'player', 'charname', 'name'];
  const CATEGORIES = [
    ['unban', /unban|revok|annul/i], ['ban', /ban(?!k)/i], ['kick', /kick|expuls/i], ['warn', /warn|avert/i],
    ['tp', /\btp|teleport|goto|bring|tpm|tp_|_tp/i], ['soin', /heal|revive|soin|reanim/i], ['spectate', /spectat|\bspec/i],
    ['noclip', /noclip|invis/i], ['freeze', /freeze|gel/i], ['prison', /jail|prison/i],
    ['argent / objets', /give|additem|add_item|setmoney|money|bank_|cash|item/i], ['véhicule', /vehic|car\b|garage|spawn|plate|plaque/i],
    ['annonce', /announce|annonce|direct_message|message/i], ['service', /duty|session|service|login|logout/i],
    ['serveur', /shutdown|restart|whitelist/i], ['accès panel', /panel_access/i],
  ];
  const pick = (d, keys) => { for (const k of keys) { const v = d?.[k]; if (v != null && v !== '' && typeof v !== 'object') return String(v); } return null; };
  const categorize = (text) => (CATEGORIES.find(([, re]) => re.test(text)) || ['autre'])[0];

  async function staff(url) {
    const p = params(url);
    const days = clampInt(p.get('days'), 7, 1, 90);
    const [ev, cmds, access] = await Promise.all([
      q(`SELECT ts, type, subtype, citizenid, player_name, data FROM events
         WHERE ts > now() - make_interval(days => $1)
           AND (type = 'admin_action' OR (type = 'game_log' AND subtype = ANY($2)))
         ORDER BY ts DESC LIMIT 3000`, [days, STAFF_TABLES]),
      q(`SELECT ts, author, payload FROM commands WHERE ts > now() - make_interval(days => $1) ORDER BY ts DESC LIMIT 200`, [days]),
      q(`SELECT updated_at AS ts, added_by, discord_id, global_name, username, access FROM panel_users
         WHERE updated_at > now() - make_interval(days => $1) AND added_by IS NOT NULL`, [days]),
    ]);
    const items = [];
    for (const r of ev.rows) {
      const d = r.data || {};
      const isTx = r.type === 'admin_action';
      const action = pick(d, ACTION_KEYS) || (isTx ? '?' : r.subtype);
      const source = isTx ? (d.source || (String(action).startsWith('bank_') ? 'banque' : 'txAdmin')) : r.subtype;
      items.push({
        ts: r.ts, source, action,
        category: r.subtype === 'teleport_admin_logs' ? 'tp' : categorize(`${r.subtype || ''} ${action}`),
        actor: pick(d, ACTOR_KEYS) || (isTx ? null : r.player_name) || '?',
        target: pick(d, TARGET_KEYS) || (isTx ? null : null),
        targetCid: d.target_cid || (isTx ? r.citizenid : r.citizenid) || null,
        reason: pick(d, ['reason', 'raison', 'details', 'message', 'note', 'description']),
        duration: pick(d, ['duration', 'durée', 'expire']),
      });
    }
    for (const c of cmds.rows) items.push({ ts: c.ts, source: 'panel', action: 'annonce', category: 'annonce', actor: c.author || '?', target: 'tous les joueurs', reason: c.payload?.message || null });
    for (const a of access.rows) items.push({ ts: a.ts, source: 'panel', action: a.access === 'granted' ? 'accès accordé' : a.access === 'revoked' ? 'accès retiré' : 'accès auto', category: 'accès panel', actor: a.added_by, target: a.global_name || a.username || a.discord_id, reason: null });
    items.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    // Classements sur toute la période, puis filtres pour la liste.
    const byActor = new Map(), byCat = {}, byDay = {};
    for (const it of items) {
      const a = byActor.get(it.actor) || { actor: it.actor, total: 0, cats: {}, last: it.ts, sources: new Set() };
      a.total++; a.cats[it.category] = (a.cats[it.category] || 0) + 1; a.sources.add(it.source);
      if (new Date(it.ts) > new Date(a.last)) a.last = it.ts;
      byActor.set(it.actor, a);
      byCat[it.category] = (byCat[it.category] || 0) + 1;
      const day = new Date(it.ts).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const fStaff = p.get('staff'), fCat = p.get('cat'), fq = (p.get('q') || '').toLowerCase().slice(0, 80);
    const list = items.filter((it) => (!fStaff || it.actor === fStaff) && (!fCat || it.category === fCat)
      && (!fq || [it.actor, it.action, it.target, it.reason, it.source].some((v) => String(v || '').toLowerCase().includes(fq))));
    return {
      days, total: items.length, truncated: ev.rows.length >= 3000,
      staff: [...byActor.values()].map((a) => ({ ...a, sources: [...a.sources] })).sort((a, b) => b.total - a.total),
      categories: byCat, days_activity: byDay, items: list.slice(0, 500),
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
  async function pull() {
    await q(`UPDATE commands SET status = 'expired' WHERE status = 'pending' AND ts < now() - interval '10 minutes'`);
    const r = await q(`UPDATE commands SET status = 'sent', sent_at = now()
                       WHERE id IN (SELECT id FROM commands WHERE status = 'pending' ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
                       RETURNING id, type, payload`);
    return r.rows;
  }
  async function ack(id, ok, result) {
    if (!/^\d+$/.test(String(id))) return;
    await q(`UPDATE commands SET status = $2, done_at = now(), result = $3 WHERE id = $1 AND status = 'sent'`,
      [id, ok ? 'done' : 'failed', String(result || '').slice(0, 300)]);
  }
  async function pullCommands(res) { return json(res, 200, { commands: await pull() }); }
  async function ackCommand(req, res, id) {
    const b = (await body(req)) || {};
    await ack(id, b.ok, b.result);
    return json(res, 200, { ok: true });
  }

  return {
    api: { timeline, linked, search, trace, inflation, scripts, staff },
    // Utilisés par /v1/batch : bl_telemetry 1.3+ reçoit les ordres dans la réponse et renvoie les résultats avec l'envoi suivant.
    commands: { pull, ack },
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
