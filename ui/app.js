'use strict';
/* Panel Brothers Life — logique front. Pages: overview, economy, players, player, logs, admin. */

const $ = (s) => document.querySelector(s);
const charts = {};
const C = { gold: '#e8a33d', ember: '#d4572e', jade: '#6fbf8e', dim: '#9d8f91', line: '#2e2630', ink: '#efe7da' };
const THREADS = { svMain: C.gold, svNetwork: C.jade, svSync: C.ember };

Chart.defaults.color = C.dim;
Chart.defaults.borderColor = C.line;
Chart.defaults.font.family = 'Archivo, system-ui, sans-serif';

const fmt = new Intl.NumberFormat('fr-FR');
const money = (v) => (v == null ? '–' : fmt.format(Math.round(v)) + ' $');
const dt = (v) => (v ? new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(name, params = '') {
  const r = await fetch('/api/' + name + params, { credentials: 'same-origin' });
  return r.json();
}

function lineChart(id, datasets, opts = {}) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($('#' + id), {
    type: opts.type || 'line',
    data: { datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 10, boxHeight: 10 } } },
      scales: {
        x: { type: 'time' in opts ? 'time' : 'linear', ...(opts.xTime ? { type: 'time', time: { tooltipFormat: 'dd/MM HH:mm' } } : {}), grid: { color: C.line }, ticks: { maxTicksLimit: 8, callback: opts.xTime ? undefined : undefined } },
        y: { grid: { color: C.line }, beginAtZero: true },
      },
      ...opts.extra,
    },
  });
}

/* Chart.js sans adaptateur de dates : on convertit en labels maison. */
function tsSeries(rows, key) { return rows.map((r) => ({ x: Number(r.t), y: r[key] == null ? null : Number(r[key]) })); }
function timeTicks(chartId) {
  return { ticks: { maxTicksLimit: 7, callback: (v) => new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) }, grid: { color: C.line } };
}
function simpleLine(id, series, opts = {}) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($('#' + id), {
    type: opts.bar ? 'bar' : 'line',
    data: { datasets: series },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, normalized: true, parsing: true,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: series.length > 1, labels: { boxWidth: 10, boxHeight: 10 } } },
      scales: { x: { type: 'linear', ...timeTicks(id), ...(opts.stackedX ? { stacked: true } : {}) }, y: { beginAtZero: true, grid: { color: C.line }, ...(opts.stackedY ? { stacked: true } : {}) } },
    },
  });
}

function rows(tbodySel, list, render) {
  const tb = $(tbodySel + ' tbody');
  tb.innerHTML = list.length ? list.map(render).join('') : '<tr><td colspan="9" style="color:var(--ink-dim)">Rien pour le moment.</td></tr>';
}

const playerLink = (cid, label) => cid ? `<a href="#player=${encodeURIComponent(cid)}">${esc(label || cid)}</a>` : esc(label || '–');

/* --------------------------------- pages --------------------------------- */

async function loadOverview() {
  const d = await api('overview', '?h=24');
  const k = d.counts || {};
  $('#hudOnline').textContent = k.online ?? '–';
  $('#hudMax').textContent = k.max ? '/ ' + k.max : '';
  $('#kChars').textContent = fmt.format(k.chars ?? 0);
  $('#kSessions').textContent = fmt.format(k.sessions24 ?? 0);
  $('#kDeaths').textContent = fmt.format(k.deaths24 ?? 0);
  $('#kEvents').textContent = fmt.format(k.events24 ?? 0);

  const up = Number(k.up) === 1;
  $('#statusDot').className = 'dot ' + (up ? 'up' : 'down');
  $('#statusText').textContent = up ? 'serveur en ligne' : 'serveur injoignable';
  $('#statusPlayers').textContent = (k.online ?? '–') + ' joueurs connectés';

  // Jauge HUD : 48 segments sur l'historique 24 h
  const bars = $('#hudBars'); bars.innerHTML = '';
  const pts = d.online; const seg = 48;
  const maxV = Math.max(Number(k.max) || 0, ...pts.map((p) => Number(p.value)), 1);
  for (let i = 0; i < seg; i++) {
    const p = pts[Math.floor(i * pts.length / seg)];
    const v = p ? Number(p.value) : 0;
    const el = document.createElement('i');
    el.style.height = Math.max(5, Math.round(v / maxV * 72)) + 'px';
    if (v > 0) el.classList.add('on');
    bars.appendChild(el);
  }

  simpleLine('chOnline', [{ label: 'joueurs', data: tsSeries(d.online, 'value'), borderColor: C.gold, backgroundColor: C.gold + '33', fill: true, pointRadius: 0, borderWidth: 2, tension: .25 }]);
  const byThread = {};
  for (const r of d.tick) { if (r.ms == null) continue; (byThread[r.thread] = byThread[r.thread] || []).push({ x: Number(r.t), y: Number(r.ms) }); }
  simpleLine('chTick', Object.entries(byThread).map(([th, data]) => ({ label: th, data, borderColor: THREADS[th] || C.dim, pointRadius: 0, borderWidth: 1.5, tension: .25 })));

  rows('#tErrors', d.errors, (e) => `<tr><td>${dt(e.ts)}</td><td>${esc(e.channel)}</td><td class="lvl-error">${esc(e.line)}</td></tr>`);
}

async function loadEconomy() {
  const d = await api('economy', '?h=' + 24 * 7);
  simpleLine('chMass', [
    { label: 'cash', data: tsSeries(d.mass, 'total_cash'), borderColor: C.gold, pointRadius: 0, borderWidth: 2, tension: .25 },
    { label: 'banque', data: tsSeries(d.mass, 'total_bank'), borderColor: C.jade, pointRadius: 0, borderWidth: 2, tension: .25 },
  ]);
  const kinds = {};
  for (const r of d.flowsByHour) { const t = new Date(r.t).getTime(); (kinds[r.kind] = kinds[r.kind] || []).push({ x: t, y: Number(r.total) }); }
  const palette = [C.gold, C.jade, C.ember, C.dim, '#b084d4'];
  simpleLine('chFlows', Object.entries(kinds).map(([kind, data], i) => ({ label: kind, data, backgroundColor: palette[i % palette.length], borderWidth: 0 })), { bar: true, stackedX: true, stackedY: true });

  if (charts.chShops) charts.chShops.destroy();
  charts.chShops = new Chart($('#chShops'), {
    type: 'bar',
    data: { labels: d.shops.map((s) => s.shop), datasets: [{ data: d.shops.map((s) => Number(s.ca)), backgroundColor: C.gold, borderWidth: 0 }] },
    options: { indexAxis: 'y', animation: false, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: C.line } }, y: { grid: { display: false } } } },
  });

  rows('#tTop', d.top, (p) => `<tr><td>${playerLink(p.citizenid, p.name)}</td><td class="r">${money(p.cash)}</td><td class="r">${money(p.bank)}</td><td class="r"><b>${money(p.total)}</b></td></tr>`);
  rows('#tFlows', d.flows, (f) => `<tr><td>${dt(f.ts)}</td><td>${esc(f.kind)}</td><td>${playerLink(f.from_cid)}</td><td>${playerLink(f.to_cid)}</td><td class="r">${money(f.amount)}</td></tr>`);
  rows('#tPurchases', d.purchases, (p) => `<tr><td>${dt(p.ts)}</td><td>${playerLink(p.citizenid, p.player_name)}</td><td>${esc(p.shop)}</td><td>${esc(p.article)}</td><td class="r">${p.qty ?? 1}</td><td class="r">${money(p.total)}</td></tr>`);
}

let searchTimer;
async function loadPlayers() {
  const d = await api('players', '?q=' + encodeURIComponent($('#playerSearch').value.trim()));
  $('#playerCount').textContent = d.players.length + ' joueurs';
  rows('#tPlayers', d.players, (p) => `<tr>
    <td>${playerLink(p.citizenid, p.name)}</td><td>${esc(p.citizenid)}</td>
    <td>${esc(p.job || '–')}</td><td>${esc(p.gang || '–')}</td>
    <td class="r">${money(p.cash)}</td><td class="r">${money(p.bank)}</td><td>${dt(p.ts)}</td></tr>`);
}

const ICON_BASE = 'https://raw.githubusercontent.com/overextended/ox_inventory/main/web/images/';
async function loadPlayer(cid) {
  const d = await api('player', '?cid=' + encodeURIComponent(cid));
  const id = d.ident || {};
  $('#pName').textContent = id.name || cid;
  $('#pMeta').textContent = `${id.citizenid || cid} · ${id.job || 'sans métier'}${id.job_grade != null ? ' (grade ' + id.job_grade + ')' : ''}${id.gang && id.gang !== 'none' ? ' · gang ' + id.gang : ''} · ${id.online ? 'en ligne' : 'hors ligne, vu le ' + dt(id.ts)}`;
  $('#pHours').textContent = (Number(d.stats.hours) || 0).toFixed(1);
  $('#pDeaths').textContent = d.stats.deaths ?? 0;
  $('#pPurchases').textContent = d.stats.purchases ?? 0;
  $('#pMoney').textContent = money((Number(id.cash) || 0) + (Number(id.bank) || 0));

  simpleLine('chPlayerMoney', [
    { label: 'cash', data: tsSeries(d.money, 'cash'), borderColor: C.gold, pointRadius: 0, borderWidth: 2, tension: .25 },
    { label: 'banque', data: tsSeries(d.money, 'bank'), borderColor: C.jade, pointRadius: 0, borderWidth: 2, tension: .25 },
  ]);

  rows('#tInv', d.inventory, (it) => `<tr><td><img class="icon" loading="lazy" src="${ICON_BASE}${encodeURIComponent(it.name)}.png" onerror="this.style.display='none'" alt=""></td><td>${esc(it.name)}</td><td class="r">${fmt.format(it.count)}</td></tr>`);
  rows('#tVeh', d.vehicles, (v) => `<tr><td>${esc(v.plate)}</td><td>${esc(v.model)}</td><td>${esc(v.garage || '–')}</td><td>${v.state == 1 ? 'au garage' : v.state == 0 ? 'sorti' : esc(v.state)}</td></tr>`);
  rows('#tPDeaths', d.deaths, (m) => `<tr><td>${dt(m.ts)}</td><td>${esc(m.cause)}</td><td>${esc(m.killer_name || '–')}</td><td>${esc(m.weapon || '–')}</td></tr>`);
  rows('#tPSessions', d.sessions, (s) => `<tr><td>${dt(s.start_ts)}</td><td>${dt(s.end_ts)}</td><td class="r">${s.minutes ?? '–'}</td></tr>`);
  rows('#tPFlows', d.flows, (f) => {
    const out = f.from_cid === cid;
    const other = out ? f.to_cid : f.from_cid;
    return `<tr><td>${dt(f.ts)}</td><td>${esc(f.kind)}</td><td>${playerLink(other)}</td><td class="r ${out ? 'neg' : 'pos'}">${out ? '−' : '+'}${money(f.amount)}</td></tr>`;
  });
  rows('#tPPurchases', d.purchases, (p) => `<tr><td>${dt(p.ts)}</td><td>${esc(p.shop)}</td><td>${esc(p.article)}</td><td class="r">${money(p.total)}</td></tr>`);
  rows('#tPEvents', d.events, (e) => `<tr><td>${dt(e.ts)}</td><td>${esc(e.type)}${e.subtype ? ' · ' + esc(e.subtype) : ''}</td><td class="mono-cell">${esc(JSON.stringify(e.data)).slice(0, 220)}</td></tr>`);
}

async function loadLogs() {
  const p = new URLSearchParams();
  const s = $('#logSearch').value.trim(); if (s) p.set('q', s);
  const lv = $('#logLevel').value; if (lv) p.set('level', lv);
  const d = await api('logs', '?' + p.toString());

  const byLevel = {};
  for (const r of d.volume) { const t = new Date(r.t).getTime(); (byLevel[r.level] = byLevel[r.level] || []).push({ x: t, y: Number(r.n) }); }
  const colors = { info: C.dim, warn: C.gold, error: C.ember };
  simpleLine('chLogVolume', Object.entries(byLevel).map(([lvl, data]) => ({ label: lvl, data, backgroundColor: colors[lvl] || C.dim, borderWidth: 0 })), { bar: true, stackedX: true, stackedY: true });

  rows('#tLogs', d.logs, (l) => `<tr><td>${dt(l.ts)}</td><td>${esc(l.channel)}</td><td class="lvl-${esc(l.level)}">${esc(l.level)}</td><td>${esc(l.line)}</td></tr>`);
  rows('#tChat', d.chat, (c) => `<tr><td>${dt(c.ts)}</td><td>${playerLink(c.citizenid, c.player_name)}</td><td>${esc(c.subtype)}</td><td>${esc(c.message)}</td></tr>`);
}

async function loadAdmin() {
  const d = await api('admin');
  simpleLine('chDeaths', [{ label: 'morts', data: d.deathsByHour.map((r) => ({ x: new Date(r.t).getTime(), y: Number(r.n) })), backgroundColor: C.ember, borderWidth: 0 }], { bar: true });
  rows('#tActions', d.actions, (a) => `<tr><td>${dt(a.ts)}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.staff || '–')}</td><td>${esc(a.target || '–')}</td><td>${esc(a.reason || '–')}</td><td>${esc(a.duration || '–')}</td></tr>`);
  rows('#tConn', d.connections, (c) => `<tr><td>${dt(c.start_ts)}</td><td>${playerLink(c.citizenid, c.player_name)}</td><td>${c.end_ts ? dt(c.end_ts) : '<span class="pos">en ligne</span>'}</td></tr>`);
  rows('#tExpl', d.explosions, (e) => `<tr><td>${dt(e.ts)}</td><td>${playerLink(e.citizenid, e.player_name)}</td><td>${esc(e.type || '?')}</td></tr>`);
}

/* ------------------------------- navigation ------------------------------ */

const loaders = { overview: loadOverview, economy: loadEconomy, players: loadPlayers, logs: loadLogs, admin: loadAdmin };
let refreshTimer;

function show(page, arg) {
  document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
  const el = $('#page-' + page);
  if (!el) return;
  el.classList.remove('hidden');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page || (page === 'player' && a.dataset.page === 'players')));
  clearInterval(refreshTimer);
  const run = () => (page === 'player' ? loadPlayer(arg) : loaders[page] ? loaders[page]() : null)?.catch(console.error);
  run();
  if (page === 'overview') refreshTimer = setInterval(run, 30000);
}

function route() {
  const h = location.hash.slice(1) || 'overview';
  if (h.startsWith('player=')) show('player', decodeURIComponent(h.slice(7)));
  else show(h);
}
window.addEventListener('hashchange', route);

/* --------------------------------- login --------------------------------- */

function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); route(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) });
  if (r.ok) showApp();
  else $('#loginError').textContent = 'Mauvais mot de passe.';
});

$('#playerSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadPlayers, 300); });
$('#logSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadLogs, 400); });
$('#logLevel').addEventListener('change', loadLogs);

/* Acces direct, sans login. */
showApp();
