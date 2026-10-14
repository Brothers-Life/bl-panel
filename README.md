# bl-panel
## Lien avec le panel

L'API stocke les données, les reçoit du script FiveM (`POST /v1/batch`, jeton `INGEST_TOKEN`) et les envoie au panel.
La connexion Discord des utilisateurs est gérée par le **panel** (`bl-panel-front`), qui appelle l'API avec la clé partagée `PANEL_API_KEY` (en-tête `X-Panel-Key`).
Les comptes autorisés du panel sont stockés ici (`panel_users`, `panel_logins`) via `/api/panel-users`, réservé au panel.

Sans `PANEL_API_KEY`, les routes `/api/*` restent publiques (message au démarrage).

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres |
| `INGEST_TOKEN` | — | Jeton d'ingestion FiveM (obligatoire) |
| `FIVEM_BASE` | — | URL du serveur FiveM pour `/perf/` et `/dynamic.json` |
| `CORS_ORIGIN` | `*` | Origine CORS (le panel appelle l'API depuis son serveur, pas depuis le navigateur) |
| `PANEL_API_KEY` | — | Clé partagée avec le panel (en-tête `X-Panel-Key`) |
| `DISCORD_WEBHOOK_URL` | — | Webhook Discord des alertes (sans lui, les alertes restent visibles dans le panel) |
| `ALERT_ERRORS_5MIN` | `25` | Nombre d'erreurs console en 5 min qui déclenche une alerte |
| `ALERT_MONEY_JUMP` | `1000000` | Saut d'argent (cash + banque) entre deux snapshots qui déclenche une alerte |
| `ALERT_ANTICHEAT_CHANNEL` | `anticheat` | Canal de logs surveillé (lignes warn/error) |
| `ALERT_INTERVAL_MS` | `60000` | Fréquence de vérification des alertes |
| `PANEL_TZ` | `Europe/Paris` | Fuseau de la carte d'activité |

## Routes du panel (clé `PANEL_API_KEY`)

- `GET /api/timeline?cid=` : journal complet d'un joueur ; `GET /api/linked?cid=` : personnages liés
- `GET /api/search?q=&days=` : recherche globale ; `GET /api/trace?cid=&ts=` : origine d'un saut d'argent
- `GET /api/inflation?d=` : masse monétaire par jour, flux par type, fortune médiane
- `GET /api/scripts` : erreurs par ressource, ralentissements, état des ressources, redémarrages
- `GET|POST /api/commands` : annonces ; côté FiveM `GET /v1/commands` et `POST /v1/commands/:id/ack` (jeton `INGEST_TOKEN`)

Conservation : `RETENTION_LOGS_DAYS` (30), `RETENTION_PERF_DAYS` (90), `RETENTION_SNAPSHOTS_DAYS` (180), le reste `RETENTION_DAYS` (365).

## Routes ajoutées

- `GET /api/stream` : flux temps réel (SSE) — statut, logs, chat, connexions, morts, alertes
- `GET /api/deathmap?h=` : morts géolocalisées + captures
- `GET /api/anomalies?h=&min=` : plus gros sauts d'argent par joueur
- `GET /api/alerts` : historique des alertes + configuration
- `GET /api/insights?d=` : activité heure × jour, métiers, gangs, tueurs, armes, causes, pic, disponibilité
