# bl-panel
## Connexion Discord

Le panel est protégé par une connexion Discord. Copier `.env.example` en `.env` (ou mettre les variables chez l'hébergeur) :

1. Créer une application sur https://discord.com/developers/applications.
2. Dans **OAuth2**, copier le *Client ID* et le *Client Secret* dans `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
3. Dans **OAuth2 → Redirects**, ajouter exactement `DISCORD_REDIRECT_URI` (`https://<api>/auth/discord/callback`).
4. Mettre l'adresse du site dans `PANEL_URL` et les ID Discord des webmasters dans `WEBMASTER_DISCORD_IDS`.
5. (Facultatif) `DISCORD_GUILD_ID` + `DISCORD_ALLOWED_ROLE_IDS` pour laisser entrer automatiquement les rôles staff.

Qui peut entrer : les webmasters, les personnes autorisées depuis la page **Accès** du panel, et (si configuré) les membres du serveur Discord avec un rôle autorisé. Un webmaster peut retirer l'accès à n'importe qui (effet en 30 s max).

Tant qu'une de ces variables obligatoires manque, la connexion est désactivée et l'API reste publique (message au démarrage).

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres |
| `INGEST_TOKEN` | — | Jeton d'ingestion FiveM (obligatoire) |
| `FIVEM_BASE` | — | URL du serveur FiveM pour `/perf/` et `/dynamic.json` |
| `CORS_ORIGIN` | `*` | Origine autorisée si `PANEL_URL` n'est pas défini |
| `PANEL_URL` | — | Adresse du site du panel (connexion Discord + CORS) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | — | Application Discord (OAuth2) |
| `DISCORD_REDIRECT_URI` | — | `https://<api>/auth/discord/callback`, déclarée dans l'application Discord |
| `WEBMASTER_DISCORD_IDS` | — | ID Discord des webmasters, séparés par des virgules |
| `SESSION_SECRET` | dérivé d'`INGEST_TOKEN` | Signature des sessions |
| `SESSION_DAYS` | `7` | Durée de connexion |
| `DISCORD_GUILD_ID` / `DISCORD_ALLOWED_ROLE_IDS` | — | Accès automatique par rôle (facultatif) |
| `DISCORD_WEBHOOK_URL` | — | Webhook Discord des alertes (sans lui, les alertes restent visibles dans le panel) |
| `ALERT_ERRORS_5MIN` | `25` | Nombre d'erreurs console en 5 min qui déclenche une alerte |
| `ALERT_MONEY_JUMP` | `1000000` | Saut d'argent (cash + banque) entre deux snapshots qui déclenche une alerte |
| `ALERT_ANTICHEAT_CHANNEL` | `anticheat` | Canal de logs surveillé (lignes warn/error) |
| `ALERT_INTERVAL_MS` | `60000` | Fréquence de vérification des alertes |
| `PANEL_TZ` | `Europe/Paris` | Fuseau de la carte d'activité |

## Routes ajoutées

- `GET /api/stream` : flux temps réel (SSE) — statut, logs, chat, connexions, morts, alertes
- `GET /api/deathmap?h=` : morts géolocalisées + captures
- `GET /api/anomalies?h=&min=` : plus gros sauts d'argent par joueur
- `GET /api/alerts` : historique des alertes + configuration
- `GET /api/insights?d=` : activité heure × jour, métiers, gangs, tueurs, armes, causes, pic, disponibilité
