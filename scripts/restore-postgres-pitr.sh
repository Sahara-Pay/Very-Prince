#!/usr/bin/env bash
# Restores the very-prince-pg cluster to a specific point in time from
# WAL archives in MinIO/S3. Usage:
#   ./restore-postgres-pitr.sh "2026-07-21 03:00:00"
set -euo pipefail

TARGET_TIME="${1:?Usage: $0 '<YYYY-MM-DD HH:MM:SS>'}"

kubectl apply -n data -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: very-prince-pg-restored
spec:
  instances: 1
  bootstrap:
    recovery:
      source: very-prince-pg
      recoveryTarget:
        targetTime: "${TARGET_TIME}"
  externalClusters:
    - name: very-prince-pg
      barmanObjectStore:
        destinationPath: "s3://very-prince-pg-backups/"
        endpointURL: "https://minio.very-prince.internal"
        s3Credentials:
          accessKeyId:
            name: pg-backup-credentials
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: pg-backup-credentials
            key: SECRET_ACCESS_KEY
  storage:
    size: 20Gi
EOF

echo "Restore cluster 'very-prince-pg-restored' created — targeting ${TARGET_TIME}"
echo "Monitor with: kubectl get cluster very-prince-pg-restored -n data -w"