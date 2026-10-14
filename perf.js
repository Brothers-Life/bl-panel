'use strict';
/*
 * Performances (bl_telemetry 1.4+) :
 *   events perf_snapshot (toutes les 5 min) et profiler_snapshot (toutes les 30 min) -> tables dédiées
 *   GET /api/perf?h=   serveur (threads, ralentissements), ressources (profiler), joueurs (FPS),
 *                       intérieurs / MLO et zones lourds, entités, ressources installées, recommandations
 */
module.exports = function createPerf({ q }) {
  const clampInt = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);
  const nz = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

  async function ingest(type, d) {
    if (type === 'perf_snapshot') {
      const g = d.global || {};
      await q(`INSERT INTO perf_windows (window_s, players_online, n, fps, fps_min, worst, hist, entities) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [nz(d.window_s), nz(d.players_online), nz(g.n) || 0, nz(g.fps), nz(g.min), nz(g.worst), JSON.stringify(g.hist || null), JSON.stringify(d.entities || null)]);
      const rows = [];
      for (const z of (d.zones || []).slice(0, 300)) rows.push({ kind: 'zone', key: String(z.key), n: z.n, fps: z.fps, fps_min: z.min, worst: z.worst, obj: z.obj, peds: z.peds, veh: z.veh, x: z.x, y: z.y });
      for (const i of (d.interiors || []).slice(0, 300)) rows.push({ kind: 'interior', key: String(i.key), n: i.n, fps: i.fps, fps_min: i.min, worst: i.worst, obj: i.obj, peds: i.peds, veh: i.veh, x: i.x, y: i.y, z: i.z, players: i.players });
      for (const p of (d.players || []).slice(0, 500)) rows.push({ kind: 'player', key: String(p.cid || p.name || '?'), label: p.name || null, n: p.n, fps: p.fps, fps_min: p.min, worst: p.worst, obj: p.obj, ping: p.ping });
      if (rows.length) {
        await q(`INSERT INTO perf_buckets (kind, key, label, n, fps, fps_min, worst, obj, peds, veh, x, y, z, players, ping)
                 SELECT kind, key, label, n, fps, fps_min, worst, obj, peds, veh, x, y, z, players, ping
                 FROM jsonb_to_recordset($1::jsonb) AS t(kind text, key text, label text, n int, fps real, fps_min real, worst real,
                   obj real, peds real, veh real, x real, y real, z real, players int, ping int)`, [JSON.stringify(rows)]);
      }
      return true;
    }
    if (type === 'profiler_snapshot') {
      await q(`INSERT INTO profiler_runs (span_ms, total_ms, frames, resources, top) VALUES ($1, $2, $3, $4, $5)`,
        [nz(d.span_ms), nz(d.total_ms), nz(d.frames), JSON.stringify((d.resources || []).slice(0, 80)), JSON.stringify((d.top || []).slice(0, 50))]);
      return true;
    }
    return false;
  }

  const HITCH = /(\d+(?:\.\d+)?)\s*(?:ms|milliseconds)/i;

  async function perf(url) {
    const h = clampInt(new URL(url, 'http://x').searchParams.get('h'), 24, 1, 24 * 30);
    const iv = `now() - make_interval(hours => ${h})`;
    const [threads, corr, hitches, windows, interiors, zones, players, profiler, resMeta, errors] = await Promise.all([
      q(`WITH s AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric = 'tick_sum_sec' AND ts > ${iv}),
              c AS (SELECT ts, thread, value v FROM perf_metrics WHERE metric = 'tick_count' AND ts > ${iv}),
              x AS (SELECT s.ts, s.thread, (s.v - lag(s.v) OVER (PARTITION BY s.thread ORDER BY s.ts))
                      / NULLIF(c.v - lag(c.v) OVER (PARTITION BY c.thread ORDER BY c.ts), 0) * 1000 AS ms
                    FROM s JOIN c ON c.ts = s.ts AND c.thread = s.thread)
         SELECT thread, AVG(ms) AS avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95, MAX(ms) AS max, COUNT(*)::int AS n
         FROM x WHERE ms IS NOT NULL AND ms >= 0 GROUP BY thread`),
      q(`WITH s AS (SELECT ts, value v FROM perf_metrics WHERE metric = 'tick_sum_sec' AND thread = 'svMain' AND ts > ${iv}),
              c AS (SELECT ts, value v FROM perf_metrics WHERE metric = 'tick_count' AND thread = 'svMain' AND ts > ${iv}),
              x AS (SELECT s.ts, (s.v - lag(s.v) OVER (ORDER BY s.ts)) / NULLIF(c.v - lag(c.v) OVER (ORDER BY c.ts), 0) * 1000 AS ms
                    FROM s JOIN c ON c.ts = s.ts),
              p AS (SELECT date_trunc('hour', ts) AS t, AVG(value) AS players FROM perf_metrics WHERE metric = 'players_online' AND ts > ${iv} GROUP BY 1)
         SELECT extract(epoch FROM date_trunc('hour', x.ts)) * 1000 AS t, AVG(x.ms) AS ms, MAX(p.players) AS players
         FROM x LEFT JOIN p ON p.t = date_trunc('hour', x.ts) WHERE x.ms IS NOT NULL AND x.ms >= 0 GROUP BY 1 ORDER BY 1`),
      q(`SELECT ts, line FROM server_logs WHERE ts > ${iv} AND level = 'warn' AND line ILIKE '%hitch warning%' ORDER BY ts DESC LIMIT 5000`),
      q(`SELECT ts, window_s, players_online, n, fps, fps_min, worst, hist, entities FROM perf_windows WHERE ts > ${iv} ORDER BY ts`),
      q(`SELECT key, SUM(n)::int AS n, SUM(fps * n) / NULLIF(SUM(n), 0) AS fps, MIN(fps_min) AS fps_min, SUM(worst * n) / NULLIF(SUM(n), 0) AS worst,
                SUM(obj * n) / NULLIF(SUM(n), 0) AS obj, SUM(peds * n) / NULLIF(SUM(n), 0) AS peds, AVG(x) AS x, AVG(y) AS y, AVG(z) AS z, MAX(players) AS players
         FROM perf_buckets WHERE kind = 'interior' AND ts > ${iv} GROUP BY key HAVING SUM(n) >= 3 ORDER BY fps LIMIT 60`),
      q(`SELECT key, SUM(n)::int AS n, SUM(fps * n) / NULLIF(SUM(n), 0) AS fps, MIN(fps_min) AS fps_min, SUM(worst * n) / NULLIF(SUM(n), 0) AS worst,
                SUM(obj * n) / NULLIF(SUM(n), 0) AS obj, SUM(peds * n) / NULLIF(SUM(n), 0) AS peds, SUM(veh * n) / NULLIF(SUM(n), 0) AS veh,
                SUM(x * n) / NULLIF(SUM(n), 0) AS x, SUM(y * n) / NULLIF(SUM(n), 0) AS y
         FROM perf_buckets WHERE kind = 'zone' AND ts > ${iv} GROUP BY key HAVING SUM(n) >= 3 ORDER BY fps LIMIT 60`),
      q(`SELECT key, MAX(label) AS name, SUM(n)::int AS n, SUM(fps * n) / NULLIF(SUM(n), 0) AS fps, MIN(fps_min) AS fps_min,
                SUM(worst * n) / NULLIF(SUM(n), 0) AS worst, AVG(ping) AS ping
         FROM perf_buckets WHERE kind = 'player' AND ts > ${iv} GROUP BY key ORDER BY fps LIMIT 300`),
      q(`SELECT ts, span_ms, total_ms, frames, resources, top FROM profiler_runs WHERE ts > ${iv} ORDER BY ts DESC LIMIT 100`),
      q(`SELECT ts, columns, rows FROM db_snapshots WHERE name = '_resources'`),
      q(`SELECT COALESCE(channel, '?') AS channel, COUNT(*)::int AS n FROM server_logs WHERE ts > now() - interval '24 hours' AND level = 'error'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    ]);

    // --- joueurs (global)
    let n = 0, sum = 0, min = null, worst = 0;
    const hist = [0, 0, 0, 0, 0];
    for (const w of windows.rows) {
      if (!w.n) continue;
      n += w.n; sum += w.fps * w.n; worst += (w.worst || 0) * w.n;
      if (min == null || w.fps_min < min) min = w.fps_min;
      (w.hist || []).forEach((v, i) => { hist[i] += Number(v) || 0; });
    }
    const globalFps = n ? sum / n : null;
    const lastEnt = [...windows.rows].reverse().find((w) => w.entities)?.entities || null;

    // --- profiler : moyenne par ressource sur les échantillons, en ms par seconde de serveur (= % d'un cœur × 10)
    const resAgg = new Map();
    for (const run of profiler.rows) {
      const span = Number(run.span_ms) || 0;
      if (!span) continue;
      for (const r of run.resources || []) {
        const a = resAgg.get(r.name) || { name: r.name, msPerSec: 0, runs: 0, calls: 0 };
        a.msPerSec += (Number(r.ms) || 0) / span * 1000; a.runs++; a.calls += Number(r.n) || 0;
        resAgg.set(r.name, a);
      }
    }
    const runs = profiler.rows.filter((r) => Number(r.span_ms) > 0).length;
    const resources = [...resAgg.values()].map((a) => ({ ...a, msPerSec: a.msPerSec / Math.max(1, runs), pct: a.msPerSec / Math.max(1, runs) / 10 }))
      .sort((a, b) => b.msPerSec - a.msPerSec);

    // --- ralentissements
    let hitchMax = 0;
    for (const r of hitches.rows) hitchMax = Math.max(hitchMax, Number((HITCH.exec(r.line || '') || [])[1]) || 0);

    // --- ressources installées
    const meta = resMeta.rows[0];
    const list = (meta?.rows || []).map((r) => ({ name: r[0], state: r[1], version: r[2], map: Number(r[4]) === 1, dataFiles: Number(r[5]) || 0, clientScripts: Number(r[6]) || 0, serverScripts: Number(r[7]) || 0, files: Number(r[8]) || 0 }));

    // --- recommandations
    const rec = [];
    const add = (severity, title, detail, link) => rec.push({ severity, title, detail, link });
    const main = threads.rows.find((t) => t.thread === 'svMain');
    if (main && main.p95 > 25) add('critical', `Thread principal chargé : ${main.p95.toFixed(1)} ms par tick (95e centile)`, 'Au-delà de ~25 ms, les joueurs ressentent des désynchronisations. Regarde les ressources les plus coûteuses ci-dessous.');
    else if (main && main.p95 > 15) add('warn', `Thread principal à surveiller : ${main.p95.toFixed(1)} ms par tick (95e centile)`, 'Encore correct, mais ça monte avec le nombre de joueurs.');
    for (const r of resources.slice(0, 8)) {
      if (r.name === '(non attribué)') continue;
      if (r.pct >= 5) add(r.pct >= 15 ? 'critical' : 'warn', `${r.name} utilise ${r.pct.toFixed(1)} % du temps serveur`, 'Boucles trop fréquentes (Wait(0) côté serveur), requêtes SQL dans des boucles, events appelés en masse…');
    }
    if (hitches.rows.length >= 20) add('warn', `${hitches.rows.length} ralentissements du serveur (hitch) sur la période`, `Le pire a duré ${hitchMax} ms. Souvent : une ressource qui bloque (requête SQL synchrone, gros fichier lu d'un coup) ou une machine surchargée.`);
    if (globalFps != null) {
      for (const it of interiors.rows.slice(0, 10)) {
        const drop = (1 - it.fps / globalFps) * 100;
        if (drop >= 20 && it.n >= 5) add(drop >= 40 ? 'critical' : 'warn', `Intérieur (MLO) lourd près de ${Math.round(it.x)}, ${Math.round(it.y)} : −${drop.toFixed(0)} % de FPS`,
          `${it.fps.toFixed(0)} FPS en moyenne dedans contre ${globalFps.toFixed(0)} ailleurs, ~${Math.round(it.obj || 0)} objets chargés. Vérifie le nombre de props / textures de ce MLO.`, `#map=${Math.round(it.x)},${Math.round(it.y)}`);
      }
      for (const z of zones.rows.slice(0, 5)) {
        const drop = (1 - z.fps / globalFps) * 100;
        if (drop >= 25 && z.n >= 8) add('warn', `Zone lourde près de ${Math.round(z.x)}, ${Math.round(z.y)} : −${drop.toFixed(0)} % de FPS`,
          `~${Math.round(z.obj || 0)} objets et ${Math.round(z.peds || 0)} peds chargés en moyenne. Souvent : maps / props ajoutés, trop de PNJ ou de véhicules garés.`, `#map=${Math.round(z.x)},${Math.round(z.y)}`);
      }
      const low = players.rows.filter((p) => p.fps < 30 && p.n >= 3);
      if (low.length) add('info', `${low.length} joueur(s) sous 30 FPS en moyenne`, 'Souvent une machine faible : si c’est général, réduis les textures lourdes (véhicules / vêtements en 4K).');
      const highPing = players.rows.filter((p) => p.ping > 150);
      if (highPing.length) add('info', `${highPing.length} joueur(s) avec un ping au-dessus de 150 ms`, 'Connexion éloignée ou instable : à garder en tête pour les plaintes de désync.');
    } else add('info', 'Pas encore de mesures des joueurs', 'Installe bl_telemetry 1.4 : les FPS par zone et par MLO apparaîtront après quelques minutes de jeu.');
    if (lastEnt) {
      for (const [kind, label, limit] of [['vehicles', 'véhicules', 600], ['objects', 'objets', 6000], ['peds', 'peds', 800]]) {
        const e = lastEnt[kind];
        if (!e) continue;
        if (e.total > limit) add('warn', `${e.total} ${label} existent sur le serveur`, `Au-delà de ~${limit}, le serveur et les clients ralentissent. Pense à nettoyer les entités abandonnées.`);
        const t = e.top?.[0];
        if (t && t.n >= Math.max(30, e.total * 0.3)) add('warn', `Un même modèle de ${label.slice(0, -1)} existe ${t.n} fois (hash ${t.model})`, 'Typique d’un script qui spawn en boucle sans supprimer.');
      }
    }
    const errTop = errors.rows[0];
    if (errTop && errTop.n >= 100) add('warn', `${errTop.channel} produit ${errTop.n} erreurs en 24 h`, 'Une erreur répétée coûte aussi du temps serveur : corrige-la (détail dans la page Scripts).', '#scripts');
    const stopped = list.filter((r) => r.state !== 'started');
    if (stopped.length >= 5) add('info', `${stopped.length} ressources installées mais pas démarrées`, 'Si elles ne servent pas, retire-les du dossier resources : démarrage et scan plus rapides.');
    const heavy = [...list].filter((r) => r.state === 'started').sort((a, b) => b.files - a.files).slice(0, 3).filter((r) => r.files >= 50);
    if (heavy.length) add('info', `Ressources qui envoient le plus de fichiers aux joueurs : ${heavy.map((r) => `${r.name} (${r.files})`).join(', ')}`, 'Plus il y a de fichiers / streams, plus le chargement est long pour les nouveaux joueurs.');
    if (!runs) add('info', 'Coût des ressources serveur pas encore mesuré', 'Ajoute « add_ace resource.bl_telemetry command.profiler allow » dans server.cfg (bl_telemetry 1.4) : un échantillon est pris toutes les 30 min.');
    const order = { critical: 0, warn: 1, info: 2 };
    rec.sort((a, b) => order[a.severity] - order[b.severity]);

    return {
      hours: h,
      server: { threads: threads.rows, correlation: corr.rows, hitches: { count: hitches.rows.length, worst: hitchMax } },
      clients: { samples: n, fps: globalFps, fpsMin: min, worst: n ? worst / n : null, hist, timeline: windows.rows.map((w) => ({ t: w.ts, fps: w.fps, players: w.players_online, n: w.n })) },
      interiors: interiors.rows, zones: zones.rows, players: players.rows,
      entities: lastEnt,
      profiler: { runs, resources: resources.slice(0, 40), last: profiler.rows[0] || null },
      installed: { ts: meta?.ts || null, total: list.length, started: list.filter((r) => r.state === 'started').length, maps: list.filter((r) => r.map || r.dataFiles > 0), list },
      recommendations: rec,
    };
  }

  return { ingest, api: { perf } };
};
