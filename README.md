# bl-panel
## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres |
| `INGEST_TOKEN` | — | Jeton d'ingestion FiveM (obligatoire) |
| `FIVEM_BASE` | — | URL du serveur FiveM pour `/perf/` et `/dynamic.json` |
| `CORS_ORIGIN` | `*` | Origine autorisée (le front) |
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
