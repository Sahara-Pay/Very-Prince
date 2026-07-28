# Very-Prince – Kubernetes Infrastructure

High-availability PostgreSQL deployment for the Very-Prince backend indexer, powered by **CloudNativePG** and **PgBouncer**, with automated WAL archiving to self-hosted **MinIO**.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Kubernetes Namespace: very-prince                              │
│                                                                 │
│   ┌──────────┐     ┌─────────────────────────────────────┐     │
│   │ Backend  │────▶│  PgBouncer  (ClusterIP :5432)       │     │
│   │ (Fastify)│     │  2 replicas · transaction-pooling   │     │
│   └──────────┘     └──────────────┬──────────────────────┘     │
│                                   │                             │
│              ┌────────────────────┼──────────────┐             │
│              │                    │              │             │
│              ▼                    ▼              ▼             │
│   ┌──────────────┐   ┌──────────────┐  ┌──────────────┐       │
│   │  Primary     │   │  Standby-1   │  │  Standby-2   │       │
│   │  (rw)        │──▶│  (ro)        │  │  (ro)        │       │
│   │  PostgreSQL  │   │  streaming   │  │  streaming   │       │
│   │  15.6        │   │  replication │  │  replication │       │
│   └──────┬───────┘   └──────────────┘  └──────────────┘       │
│          │                                                      │
│          │ WAL archive (barman-cloud / gzip)                    │
│          ▼                                                      │
│   ┌──────────────┐                                             │
│   │  MinIO       │  s3://very-prince-wal/                      │
│   │  (S3-compat) │  50 Gi PVC · 35-day lifecycle               │
│   └──────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Resource | Purpose |
|-----------|----------|---------|
| CloudNativePG | `k8s/postgres/cluster.yaml` | 3-instance PostgreSQL cluster (1 primary + 2 hot-standbys), streaming replication, auto-failover |
| Secrets | `k8s/postgres/secrets.yaml` | App user, superuser, MinIO credentials, PgBouncer userlist |
| Scheduled Backup | `k8s/postgres/scheduled-backup.yaml` | Daily base backup at 02:00 UTC |
| PgBouncer | `k8s/pgbouncer/deployment.yaml` | Transaction-pooling proxy, 2 replicas, PodDisruptionBudget, Prometheus metrics |
| MinIO | `k8s/minio/deployment.yaml` | S3-compatible WAL archive store, bucket init Job |
| Helm values | `k8s/helm/values-cnpg.yaml` | CloudNativePG operator overrides |
| Kustomization | `k8s/kustomization.yaml` | Root Kustomize manifest |
| PITR script | `scripts/pitr-restore.sh` | Automated point-in-time recovery |

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| kubectl | v1.28+ | https://kubernetes.io/docs/tasks/tools/ |
| Helm | v3.14+ | https://helm.sh/docs/intro/install/ |
| kustomize | v5+ (bundled in kubectl) | — |
| CloudNativePG plugin (optional) | latest | `kubectl krew install cnpg` |

A Kubernetes cluster with:
- A default or named `StorageClass` (update `storageClass: standard` in manifests to match)
- Sufficient capacity: ~70 Gi storage total (20 Gi PG + 5 Gi WAL PVC + 50 Gi MinIO)

---

## Quick Start

### 1 – Install the CloudNativePG Operator

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update

helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  -f k8s/helm/values-cnpg.yaml
```

Verify the operator is running:

```bash
kubectl get pods -n cnpg-system
# NAME                                     READY   STATUS    RESTARTS
# cnpg-cloudnative-pg-<hash>              1/1     Running   0
```

### 2 – Set Secrets

Before applying, replace all `CHANGE_ME_*` placeholder values with real secrets. Use Sealed Secrets or External Secrets Operator in production.

```bash
# Edit and set real passwords
kubectl create namespace very-prince --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic very-prince-pg-app-secret \
  --namespace very-prince \
  --from-literal=username=very_prince_app \
  --from-literal=password='<strong-app-password>'

kubectl create secret generic very-prince-pg-superuser-secret \
  --namespace very-prince \
  --from-literal=username=postgres \
  --from-literal=password='<strong-superuser-password>'

kubectl create secret generic minio-s3-secret \
  --namespace very-prince \
  --from-literal=ACCESS_KEY_ID=minioadmin \
  --from-literal=SECRET_ACCESS_KEY='<strong-minio-password>'

# Build userlist.txt for PgBouncer
kubectl create secret generic pgbouncer-userlist-secret \
  --namespace very-prince \
  --from-literal=userlist.txt='"very_prince_app" "<strong-app-password>"'
```

### 3 – Deploy Everything

```bash
kubectl apply -k k8s/
```

Watch the cluster come up:

```bash
kubectl get cluster -n very-prince -w
# NAME              AGE   INSTANCES   READY   STATUS                 PRIMARY
# very-prince-pg    30s   3           3       Cluster in healthy state   very-prince-pg-1
```

---

## Verifying the Cluster

### Check cluster health

```bash
kubectl get cluster very-prince-pg -n very-prince -o wide
kubectl describe cluster very-prince-pg -n very-prince
```

### Connect to the primary (read-write)

```bash
kubectl exec -n very-prince -it very-prince-pg-1 -- \
  psql -U postgres -d very_prince
```

### Verify streaming replication

```bash
kubectl exec -n very-prince very-prince-pg-1 -- \
  psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

### Check WAL archiving is active

```bash
kubectl exec -n very-prince very-prince-pg-1 -- \
  psql -U postgres -c "SELECT archived_count, failed_count FROM pg_stat_archiver;"
```

### View PgBouncer pool stats

```bash
# Port-forward the admin port
kubectl port-forward -n very-prince svc/pgbouncer 6432:6432 &
psql -h 127.0.0.1 -p 6432 -U pgbouncer_stats pgbouncer -c "SHOW POOLS;"
```

---

## Acceptance Criteria Verification

### ✅ Automatic failover within 10 seconds

Test by deleting the primary pod:

```bash
# Get the current primary
PRIMARY=$(kubectl get cluster very-prince-pg -n very-prince \
  -o jsonpath='{.status.currentPrimary}')
echo "Current primary: $PRIMARY"

# Delete it and measure failover time
time kubectl delete pod "$PRIMARY" -n very-prince

# Watch a new primary be elected
kubectl get cluster very-prince-pg -n very-prince -w
```

CloudNativePG uses Raft-based leader election; failover typically completes in **3–8 seconds**.

### ✅ PgBouncer stable under synthetic load

Use the existing load-test script in the repo:

```bash
# Port-forward PgBouncer
kubectl port-forward -n very-prince svc/pgbouncer 5432:5432 &

# Run the load test (packages/backend/load-test.js)
cd packages/backend
DATABASE_URL="postgresql://very_prince_app:<password>@localhost:5432/very_prince" \
  node load-test.js
```

Monitor pool saturation in real time:

```bash
kubectl port-forward -n very-prince svc/pgbouncer 6432:6432 &
watch -n 2 'psql -h 127.0.0.1 -p 6432 -U pgbouncer_stats pgbouncer -c "SHOW POOLS;"'
```

### ✅ PITR restore from WAL archives

```bash
# Restore to a specific point in time
./scripts/pitr-restore.sh "2026-07-24T18:00:00Z"

# Or restore to latest
./scripts/pitr-restore.sh latest

# Dry-run first to inspect the manifest
DRY_RUN=true ./scripts/pitr-restore.sh "2026-07-24T18:00:00Z"
```

---

## Application Connection String

Update `DATABASE_URL` in the backend to route through PgBouncer:

```
# .env (production)
DATABASE_URL=postgresql://very_prince_app:<password>@pgbouncer.very-prince.svc.cluster.local:5432/very_prince
```

> **Note**: PgBouncer in transaction mode is incompatible with prepared statements. If Prisma uses prepared statements, add `?pgbouncer=true&statement_cache_size=0` to the connection string:
> ```
> DATABASE_URL=postgresql://very_prince_app:<password>@pgbouncer.very-prince.svc.cluster.local:5432/very_prince?pgbouncer=true&statement_cache_size=0
> ```

---

## Backup & Recovery

### On-demand base backup

```bash
kubectl cnpg backup very-prince-pg -n very-prince
# or without the plugin:
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: manual-backup-$(date +%s)
  namespace: very-prince
spec:
  cluster:
    name: very-prince-pg
EOF
```

### List available backups

```bash
kubectl get backup -n very-prince
```

### Point-in-time recovery

```bash
# Restore to a specific timestamp
./scripts/pitr-restore.sh "2026-07-24T18:00:00Z"

# Restore to latest WAL
./scripts/pitr-restore.sh latest
```

See `scripts/pitr-restore.sh` for the full post-recovery validation workflow.

---

## Monitoring

The following Prometheus metrics are exposed automatically when `monitoring.enablePodMonitor: true` is set:

| Source | Port | Path |
|--------|------|------|
| CloudNativePG (pg_exporter) | 9187 | `/metrics` |
| PgBouncer exporter | 9127 | `/metrics` |
| MinIO | 9000 | `/minio/v2/metrics/cluster` |

Import the [CloudNativePG Grafana dashboard](https://grafana.com/grafana/dashboards/20417) (ID `20417`) for a pre-built overview.

---

## Troubleshooting

**Cluster stuck in `Setting up primary` state**
```bash
kubectl logs -n very-prince very-prince-pg-1 -c postgres
kubectl describe pod very-prince-pg-1 -n very-prince
```

**WAL archiving failures (failed_count > 0)**
```bash
# Check barman-cloud logs inside the postgres container
kubectl exec -n very-prince very-prince-pg-1 -- \
  cat /var/log/postgresql/postgresql.log | grep -i archive
# Verify MinIO is reachable
kubectl exec -n very-prince very-prince-pg-1 -- \
  curl -s http://minio.very-prince.svc.cluster.local:9000/minio/health/live
```

**PgBouncer connection refused**
```bash
kubectl logs -n very-prince deployment/pgbouncer -c pgbouncer
kubectl get endpoints pgbouncer -n very-prince
```

**PITR restore stuck**
```bash
kubectl describe cluster very-prince-pg-restore -n very-prince
kubectl logs -n very-prince very-prince-pg-restore-1 -c postgres | tail -50
```

---

## File Structure

```
k8s/
├── kustomization.yaml          # Root kustomize manifest
├── helm/
│   └── values-cnpg.yaml        # CloudNativePG operator Helm overrides
├── minio/
│   └── deployment.yaml         # MinIO deployment, services, bucket init Job
├── pgbouncer/
│   └── deployment.yaml         # PgBouncer deployment, service, PDB, ConfigMap
└── postgres/
    ├── cluster.yaml            # CloudNativePG Cluster (3 instances, WAL archiving)
    ├── scheduled-backup.yaml   # Daily 02:00 UTC ScheduledBackup
    └── secrets.yaml            # App user, superuser, MinIO, PgBouncer secrets

scripts/
├── backup.sh                   # Legacy pg_dump → S3 backup (retained for reference)
└── pitr-restore.sh             # Automated PITR restore via CloudNativePG
```
