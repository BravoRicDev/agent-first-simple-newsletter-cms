# Cluster multi-nodo "gemello" (ridondanza Active/Active)

Guida completa per far girare il CMS su **2+ server ridondanti** con copie
"gemelle" di tutto il contenuto.

**Decisioni di riferimento** (concordate):
| Tema | Scelta |
|---|---|
| Topologia | **Active/Active** (entrambi i nodi servono traffico) |
| Database | **Replica streaming PostgreSQL + Patroni** (auto-failover) |
| Sincronizzazione file | **Syncthing bidirezionale** (`media/`, `media-protected/`, `static/`, `backups/`) |
| Nodi | **2, stesso datacenter/rete** (+ 3° membro etcd witness per il quorum) |

---

## 1. Architettura target

```
                [Cloudflare DNS / Load Balancing]
                             │  health check GET /health
             ┌───────────────┴───────────────┐
       ┌─────▼─────┐                   ┌─────▼─────┐
       │ NODO A     │                   │ NODO B     │
       │ Caddy:8080 │                   │ Caddy:8080 │
       │ app:3000   │ (active)          │ app:3000   │ (active)
       │ Patroni 16 │ (leader)  ◄────►  │ Patroni 16 │ (standby)
       │ etcd-a     │                   │ etcd-b     │
       │ Syncthing  │ ◄── bidirezionale──│ Syncthing  │
       └─────┬──────┘  media + protetto  └─────┬──────┘
             │        static + backups         │
             └──────────┬──────────────────────┘
                        │
                 [etcd-witness: 3° membro per quorum]
                 [host Caddy LB (opzionale) sulla stessa rete]
```

Regole d'oro:
1. **DB**: una sola fonte di verità logica = cluster Patroni (leader + standby).
   Lo standby riceve copia fisica quasi in tempo reale via streaming replication.
2. **File**: qualunque nodo può scrivere → Syncthing propaga all'altro in
   secondi. `static/` e `backups/` sono scritte SOLO dal nodo che detiene il
   lock scheduler (advisory lock) e poi propagate.
3. **Job**: lo scheduler interno e il tick esterno usano `pg_advisory_lock`
   (già presenti in `scheduler.js`, e ora anche in `db/migrate.js` e
   `services/tick.js`): mai doppie esecuzioni cross-nodo.
4. **Auth**: JWT stateless + cookie: nessuna sessione da condividere; i segreti
   (`JWT_SECRET`, `ENCRYPTION_KEY`, chiavi provider) devono essere IDENTICI su
   tutti i nodi.

---

## 2. Contenuti che devono restare "gemelli"

| Strato | Percorso | Dove viene scritto | Sync |
|---|---|---|---|
| Dati | PostgreSQL (`cms_sites`) | leader Patroni | streaming replication |
| Media pubblici | `media/<siteId>/` | qualunque nodo (upload/import) | Syncthing bidirezionale |
| Media protetti | `media-protected/` | qualunque nodo (chiamate, GDPR) | Syncthing bidirezionale (TLS, perms 700) |
| Export statici | `static/` | solo nodo con lock scheduler | Syncthing (leader → tutti) |
| Backup | `backups/` | solo nodo con lock scheduler | Syncthing (leader → tutti) |

---

## 3. Prerequisiti e preparazione dei 2 nodi

Su **entrambi** i nodi (A e B), stesso DC/rete:

```bash
# Repo + dipendenze identiche
git clone <repo> gestione-siti-riccardom && cd gestione-siti-riccardom

# Reti Docker
docker network create edge_net
docker network create gestione_siti
docker network create cluster_net

# Ambiente: copia e adatta (stessi segreti su entrambi!, cambia solo il per-nodo)
cp .env.example .env
cp infra/cluster/.env.cluster.example infra/cluster/.env.cluster
nano infra/cluster/.env.cluster     # NODE_ID / NODE_IP / PATRONI_NAME per nodo
```

> **Importante**: `JWT_SECRET`, `ENCRYPTION_KEY`, `MAGIC_LINK_BASE_URL` (= dominio
> pubblico), SMTP, chiavi provider: **identici** su A e B. Non generarne di
> nuovi per nodo (a differenza di quanto possono suggerire i commenti
> dell'`.env.example` per installazioni singole).

### 3.1 Seed iniziale del 2° nodo (una tantum, dal nodo primario A)

Prima di attivare Syncthing, copia ONE-WAY i contenuti esistenti:

```bash
# Sul nodo A
SEED_TARGET=user@<IP_NODO_B> infra/cluster/seed-sync.sh
```

Questa copia rende B "gemello" esatto di A per i 4 alberi dati (rsync
`--delete`, preserva symlink di `static/*.dominio` e permessi).

---

## 4. Database: replica streaming + Patroni

### 4.1 Componenti

- **Patroni** via immagine **Spilo 16** (`ghcr.io/zalando/spilo-16`) su ogni
  nodo: un container che include PostgreSQL 16 + Patroni + tool `pg_*`.
- **etcd** a **3 membri** (etcd-a su A, etcd-b su B, etcd-witness su un host
  leggero) come DCS per il quorum. Con 2 soli membri etcd non ci sarebbe
  quorum quando un nodo cade → failover non affidabile.

### 4.2 Avvio

Su **A** e **B** (valori del proprio `.env.cluster`):

```bash
docker compose --env-file .env.cluster -f infra/cluster/docker-compose.node.yml up -d
```

Sull'**host witness**:

```bash
docker compose -f infra/cluster/docker-compose.etcd-witness.yml up -d
```

Verifica:

```bash
curl http://<NODO_A_IP>:8008/cluster
# deve mostrare: node-a role=leader, node-b role=standby (sync_state quorum/sync)
infra/cluster/check-replication.sh     # NODE_A_IP=... NODE_B_IP=...
```

### 4.3 Bootstrapping del DB applicativo (una tantum, sul leader)

Spilo crea il superuser (postgres) e l'utente di replica. Il CMS usa un ruolo
+DATABASE dedicati → crearli **una volta sola** sul leader:

```bash
docker exec -it patroni-<NODE_ID> psql -U postgres <<'SQL'
CREATE ROLE cmsuser LOGIN PASSWORD '<stessa di CLUSTER_DATABASE_URL>';
CREATE DATABASE cms_sites OWNER cmsuser;
SQL
```

Poi, nell'app: `CLUSTER_DATABASE_URL=postgres://cmsuser:...@patroni-<NODE_ID>:5432/cms_sites`
(Patroni espone il leader sulla porta del container locale; le migrazioni
gireranno sul leader grazie al lock in `db/migrate.js`).

### 4.4 Failover

Patroni promuove automaticamente lo standby se il leader muore (via etcd).
Lo standby promosso diventa leader; l'altro nodo diventa standby appena torna.
Implementazione già predisposta:
- advisory lock multi-nodo in `db/migrate.js` (avvii concorrenti sicuri);
- le istanze app puntano a `CLUSTER_DATABASE_URL` (endpoint Patroni) → seguono
  il leader senza riavvio manuale;
- lo scheduler usa già `pg_try_advisory_lock`.

### 4.5 (Opzionale) RPO=0 con synchronous mode

In `docker-compose.node.yml` su Patroni aggiungere:

```yaml
PATRONI_SYNCHRONOUS_MODE: "on"
PATRONI_SYNCHRONOUS_REPLICATOR_MODE: on
```

Il commit risulta confermato anche sullo standby (`sync_state=sync`).

---

## 5. Sincronizzazione file: Syncthing bidirezionale

Container `syncthing-<NODE_ID>` incluso in `infra/cluster/docker-compose.node.yml`
con 4 cartelle montate: `media/`, `media-protected/`, `static/`, `backups/`.

Configurazione **una tantum** (da fare su entrambi i nodi):
1. Apri la Web UI: `http://<NODE_IP>:8384`.
2. Aggiungi il **device** dell'altro nodo (ID mostrato nella sua UI).
3. Per ognuna delle 4 cartelle: "Share" con l'altro nodo, **tipo Send & Receive**
   (bidirezionale), **Scan interval** breve (es. 60s), **Watcher** abilitato.
4. In **opzioni avanzate** di ogni cartella: "Sincronizza i symlink" = **YES**
   (i domini in `static/` sono symlink tipo `neparliamoasettembre.it -> 2`).
5. Incolla le regole di `infra/cluster/syncthing/ignore-patterns.txt` in
   "Ignore Patterns" di OGNI cartella, identiche su **entrambi** i nodi.
6. **Sicurezza**: Web UI protetta da password/API key; sync su rete privata do
   i nodi (i pattern TLS di Syncthing cifrano i trasferimenti); `media-protected`
   resta accessibile SOLO dalle route Express autorizzate (nessun
   `express.static`, già denny-by-default).

Verifica di allineamento: `infra/cluster/verify-twin.sh`.

> Conflitti: per `media/` i nomi file sono `timestamp-hash.ext` univoci, quindi
> le collisioni sono di fatto impossibili. Per le cartelle leader-only
> (`static/`, `backups/`) solo il nodo col lock scrive: niente conflitti.

---

## 6. Applicazione su nodi cluster

Su ogni nodo cluster l'app va avviata con il compose dedicato (senza `db`):

```bash
docker compose --env-file infra/cluster/.env.cluster \
  -f infra/cluster/docker-compose.app.yml up -d
```

Vantaggi: i volumi `media/`, `media-protected/`, `static/`, `backups/` sono gli
stessi cartelle dello stack Syncthing (read+write locali), e Caddy per-nodo
continua a servire `static/{host}` e `/media/*` dal disco locale sincronizzato.
`start.sh` fa migrazioni (lockate) + export statico + avvio.

> Se preferisci NON usare Spilo e restare su `postgres:16-alpine`, la
> alternativa è la replica streaming classica: standby con `pg_basebackup`
> + `standby.signal` + promozione manuale/schedulata. Meno resiliente (niente
> auto-failover), ma più familiare. In quel caso lo script `check-replication.sh`
> resta utile per il lag.

---

## 7. Edge / Load Balancer / failover

**Opzione 1 — Cloudflare Load Balancing** (consigliata, se già usi CF):
- Crea due *pool*: IP di A e di B.
- Health check **HTTPS su `/health`** (endpoint già presente, verifica anche DB).
- Se un pool non risponde, tutto il traffico va all'altro; al rientro, ripristino.
- I domini pubblici continuano a puntare a Cloudflare (nessuna modifica DNS).
- `MAGIC_LINK_BASE_URL`/URL nelle email: resta il dominio pubblico.

**Opzione 2 — Caddy LB dedicato** (stesso DC, es. sull'host witness):
vedi `infra/cluster/caddy-lb/Caddyfile`, con `reverse_proxy` verso A:8080 e
B:8080 + `health_uri /health`.

**Opzione 3 — DNS round-robin**: semplice ma senza health check: sconsigliata
come unica (no failover automatico).

---

## 8. Job pianificati e tick (nessuna doppia esecuzione)

| Job | Protezione |
|---|---|
| Scheduler interno (`scheduler.js`, ogni 60s) | `pg_try_advisory_lock` (già presente) |
| Export statico + backup giornaliero | eseguiti solo dal nodo col lock; propagati da Syncthing |
| `/api/agent/tick` (cron esterno `scripts/run-tick.sh`) | **nuovo** `pg_advisory_lock` in `services/tick.js` |
| Migrazioni al boot (`node db/migrate.js`) | **nuovo** advisory lock in `db/migrate.js` |
| Webhook OUT (outbox `webhook_deliveries`) | **nuovo** lock globale + claim atomico `FOR UPDATE SKIP LOCKED` (status `sending`) + reaper righe stale — un solo nodo consegna, mai due volte |
| Push bidirezionale GoHighLevel (outbox `source_push_queue`) | **nuovo** servizio `source-sync/push.js`: lease per-sito + claim atomico + **anti-echo** (le mutate originate da GHL non tornano a GHL) + niente push durante import/sync o con replica indietro |
| Migrazioni/schermo | advisory lock per `recurring.checkFollowups` e claim atomico per `workflows.processDelayedActions` |

Puoi quindi schedulare `run-tick.sh` su **entrambi** i nodi (o da un unico cron
puntato al dominio pubblico): il secondo che arriva salterà (risposta
`{"tick":N,"skipped":true}`).

## 8bis — Sync bidirezionale con GoHighLevel (opzionale, per sito)

Oltre all'**import** GHL→CMS (`source_sync_config`), è disponibile il **push**
CMS→GHL (contatti e opportunità), **opzionale** e disattivato di default.

- **Configurazione per sito** (agent API, stessi endpoint source-sync):
  `GET/PUT /api/agent/sites/:siteId/source-sync/config` con
  `push_enabled`, `pushDirection` (`in`|`out`|`bidirectional`), `pushEvents`
  (es. `["contact","opportunity"]`). Riusa `baseUrl`/`token`/`locationId`.
- **Coda**: tabella `source_push_queue` (outbox). Enqueue automatico dalle
  mutate del CMS (contatto creato/aggiornato/taggato, opportunità
  creata/aggiornata/eliminata).
- **Single-fire in cluster**: `services/source-sync/push.js` garantisce che
  in ogni finestra UN SOLO nodo sparì a GHL: lease per-sito (`advisory lock`),
  claim atomico (`FOR UPDATE SKIP LOCKED`), **niente invio durante un import
  in corso** o quando un eventuale standby è indietro (lag replica) — la tua
  regola "solo da quello nuovo e solo senza sync in corso".
- **Anti-cascata**: le mutate con origine `ghl_in`/`import` (arrivate da GHL)
  **non vengono mai rispedite** a GHL → niente loop A→GHL→A→GHL….
- **Monitor**: `GET /api/agent/sites/:siteId/ghl-push` (stato coda),
  `POST .../ghl-push/run` (run manuale).

---

## 9. Monitoraggio e verifica di "gemellanza"

```bash
# 1. File identici (checksum, dry-run) — dal nodo A
TWIN_TARGET=user@10.0.0.2 infra/cluster/verify-twin.sh

# 2. Stato cluster Patroni + lag replica
NODE_A_IP=10.0.0.1 NODE_B_IP=10.0.0.2 infra/cluster/check-replication.sh

# 3. Lag nel dettaglio (dal leader)
docker exec patroni-A psql -U postgres -c \
  "SELECT client_addr, state, sync_state, \
          pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes \
   FROM pg_stat_replication;"
```

Alert da monitorare: lag `pg_stat_replication`, stato `/health` dei nodi,
`http://<ip>:8008/health` di Patroni, conflitti Syncthing.

---

## 10. Deploy del codice su entrambi i nodi

- I nodi usano lo **stesso repo git**; il deploy va fatto **sequenzialmente**
  (mai mezzo cluster): pull + `up -d` su A → verifica `/health` → poi B.
- Creare **una sola volta all'anno** il seed? No: il seed serve solo al bootstrap
  iniziale. Dopo, Syncthing e la replica li tengono allineati.
- Al primo deploy `start.sh` lancia migrazioni: il lock multi-nodo evita gare
  tra A e B che ripartono insieme.

---

## 11. Test di accettazione (failover)

1. Upload media su B → visibile su A (entro il beat di Syncthing).
2. Publish pagina su A → export statico su **entrambi** (lock+propagazione) e
   purge Cloudflare.
3. `docker kill` del nodo A → il traffico passa a B (LB) e Patroni promuove B
   (leader) in ~10-30s; le scritture proseguono su B.
4. Rientro di A → Patroni lo riallinea come standby; Syncthing riallinea i file.
5. `verify-twin.sh` di nuovo verde.

---

## 12. File del kit

```
docs/CLUSTER.it.md                    ← questa guida
infra/cluster/
├── docker-compose.node.yml           ← etcd + Patroni(Spilo) + Syncthing per nodo
├── docker-compose.app.yml            ← app CMS per nodo cluster (senza db)
├── docker-compose.etcd-witness.yml   ← 3° membro etcd (quorum)
├── .env.cluster.example              ← variabili per-nodo
├── seed-sync.sh                      ← bootstrap one-way (primario → gemello)
├── verify-twin.sh                    ← verifica file + lag DB
├── check-replication.sh              ← stato Patroni + lag
├── syncthing/ignore-patterns.txt     ← regole di esclusione condivise
└── caddy-lb/Caddyfile                ← esempio load balancer Caddy
```