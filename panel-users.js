'use strict';
/*
 * Stockage des comptes du panel (la connexion Discord elle-meme est geree par le panel).
 * Routes reservees au panel (cle PANEL_API_KEY) :
 *   GET  /api/panel-users            -> comptes + dernieres tentatives de connexion
 *   GET  /api/panel-users/:id        -> un compte (ou null)
 *   POST /api/panel-users/login      -> enregistre une tentative de connexion
 *   POST /api/panel-users/access     -> autorise / retire / remet en automatique un compte
 */
module.exports = function createPanelUsers({ q, json, readBody }) {
  const isId = (id) => /^\d{15,22}$/.test(String(id || ''));
  const body = async (req) => { try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return null; } };

  return async function handle(req, res, url) {
    const rest = url.slice('/api/panel-users'.length);

    if (req.method === 'GET' && rest === '') {
      const [users, logins] = await Promise.all([
        q(`SELECT discord_id, username, global_name, avatar, access, role_ok, first_login, last_login, added_by, note, updated_at
           FROM panel_users ORDER BY last_login DESC NULLS LAST, discord_id`),
        q('SELECT ts, discord_id, username, allowed, ip FROM panel_logins ORDER BY ts DESC LIMIT 100'),
      ]);
      return json(res, 200, { users: users.rows, logins: logins.rows });
    }

    if (req.method === 'GET' && /^\/\d{15,22}$/.test(rest)) {
      const r = await q('SELECT discord_id, access, role_ok FROM panel_users WHERE discord_id = $1', [rest.slice(1)]);
      return json(res, 200, { user: r.rows[0] || null });
    }

    if (req.method === 'POST' && rest === '/login') {
      const b = await body(req);
      if (!b || !isId(b.discord_id)) return json(res, 400, { error: 'discord_id invalide' });
      await q(`INSERT INTO panel_users (discord_id, username, global_name, avatar, role_ok, first_login, last_login)
               VALUES ($1, $2, $3, $4, $5, now(), now())
               ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, global_name = EXCLUDED.global_name,
                 avatar = EXCLUDED.avatar, role_ok = EXCLUDED.role_ok, last_login = now(),
                 first_login = COALESCE(panel_users.first_login, now())`,
        [b.discord_id, b.username || null, b.global_name || null, b.avatar || null, !!b.role_ok]);
      await q('INSERT INTO panel_logins (discord_id, username, allowed, ip) VALUES ($1, $2, $3, $4)',
        [b.discord_id, b.global_name || b.username || null, !!b.allowed, String(b.ip || '').slice(0, 64) || null]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === '/access') {
      const b = await body(req);
      if (!b || !isId(b.discord_id)) return json(res, 400, { error: 'ID Discord invalide (15 à 22 chiffres)' });
      const access = b.access === 'granted' || b.access === 'revoked' ? b.access : null;
      await q(`INSERT INTO panel_users (discord_id, access, added_by, note, updated_at) VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (discord_id) DO UPDATE SET access = EXCLUDED.access, added_by = EXCLUDED.added_by,
                 note = COALESCE(EXCLUDED.note, panel_users.note), updated_at = now()`,
        [b.discord_id, access, b.added_by ? String(b.added_by).slice(0, 80) : null, b.note == null ? null : String(b.note).slice(0, 200)]);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'inconnu' });
  };
};
