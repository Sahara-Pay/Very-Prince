#!/usr/bin/env python3
"""
prune_snapshots — Lambda handler for RDS snapshot lifecycle management.

Reads RETENTION_DAYS from the environment variable, queries all manual RDS DB
snapshots and DB cluster snapshots via boto3, and deletes any whose
SnapshotCreateTime is older than RETENTION_DAYS.

Pagination is handled via the Marker / NextToken mechanism returned by the RDS
API.  A JSON summary of deleted and kept snapshots is written to stdout.
"""

import json
import os
from datetime import datetime, timezone, timedelta

import boto3

rds = boto3.client("rds")


def lambda_handler(event, context):
    """
    Entry point for AWS Lambda.
    """
    try:
        retention_days = int(os.environ["RETENTION_DAYS"])
    except (KeyError, ValueError) as exc:
        msg = f"Invalid or missing RETENTION_DAYS environment variable: {exc}"
        print(json.dumps({"error": msg}))
        raise RuntimeError(msg) from exc

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    summary = {"deleted_dbs": [], "deleted_clusters": [], "kept_dbs": [], "kept_clusters": []}

    # ── DB snapshots (manual) ──────────────────────────────────────────────
    marker = None
    while True:
        kwargs = {"SnapshotType": "manual"}
        if marker:
            kwargs["Marker"] = marker

        resp = rds.describe_db_snapshots(**kwargs)
        for snap in resp.get("DBSnapshots", []):
            create_time = snap["SnapshotCreateTime"].replace(tzinfo=timezone.utc)
            if create_time < cutoff:
                _delete_db(snap["DBSnapshotIdentifier"])
                summary["deleted_dbs"].append(snap["DBSnapshotIdentifier"])
            else:
                summary["kept_dbs"].append(snap["DBSnapshotIdentifier"])

        marker = resp.get("Marker")
        if not marker:
            break

    # ── DB cluster snapshots (manual) ───────────────────────────────────────
    marker = None
    while True:
        kwargs = {"SnapshotType": "manual"}
        if marker:
            kwargs["Marker"] = marker

        resp = rds.describe_db_cluster_snapshots(**kwargs)
        for snap in resp.get("DBClusterSnapshots", []):
            create_time = snap["SnapshotCreateTime"].replace(tzinfo=timezone.utc)
            if create_time < cutoff:
                _delete_cluster(snap["DBClusterSnapshotIdentifier"])
                summary["deleted_clusters"].append(snap["DBClusterSnapshotIdentifier"])
            else:
                summary["kept_clusters"].append(snap["DBClusterSnapshotIdentifier"])

        marker = resp.get("Marker")
        if not marker:
            break

    # ── Summary ──────────────────────────────────────────────────────────
    result = {
        "deleted_snapshot_count": len(summary["deleted_dbs"]),
        "kept_snapshot_count": len(summary["kept_dbs"]),
        "deleted_cluster_snapshot_count": len(summary["deleted_clusters"]),
        "kept_cluster_snapshot_count": len(summary["kept_clusters"]),
        "retention_days": retention_days,
        "cutoff_utc": cutoff.isoformat(),
    }

    print(json.dumps(result, default=str))
    return result


def _delete_db(identifier):
    """Delete a single RDS DB snapshot by identifier."""
    try:
        rds.delete_db_snapshot(DBSnapshotIdentifier=identifier)
        print(f"Deleted DB snapshot: {identifier}")
    except Exception as exc:
        print(f"Failed to delete DB snapshot {identifier}: {exc}")
        raise


def _delete_cluster(identifier):
    """Delete a single RDS DB cluster snapshot by identifier."""
    try:
        rds.delete_db_cluster_snapshot(DBClusterSnapshotIdentifier=identifier)
        print(f"Deleted DB cluster snapshot: {identifier}")
    except Exception as exc:
        print(f"Failed to delete DB cluster snapshot {identifier}: {exc}")
        raise