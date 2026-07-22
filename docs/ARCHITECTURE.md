
# Very-Prince Infrastructure Architecture

## Overview

This document describes the AWS infrastructure provisioned via Terraform for the very-prince backend service and its Next.js static-asset CDN. The infrastructure enables CloudWatch log aggregation, metric alarms, dashboards, SNS alert notifications for an ECS Fargate cluster, global delivery of immutable frontend bundles, and automated lifecycle management for RDS snapshots.

```mermaid
flowchart TD
    subgraph AWS["AWS us-east-1"]
        subgraph VPC["VPC"]
            subgraph Private["Private Subnets"]
                ECS["ECS Fargate Cluster\n(Container Insights Enabled)"]
                Service["ECS Service\nvery-prince-backend"]
                Task["Fargate Tasks\n(CPU: 512, Mem: 1024 MiB)"]
            end
            
            subgraph Monitoring["Monitoring"]
                CWLogs["CloudWatch Log Group\n/ecs/very-prince-backend"]
                CWDashboard["CloudWatch Dashboard"]
                CWAlerts["CloudWatch Alarms\nCPU ≥ 80%, Memory ≥ 80%"]
                SNSTopic["SNS Topic\nvery-prince-shared-critical-alerts"]
                Email["Email Subscriptions"]
            end
        end
        
        State["Terraform State\nS3 + DynamoDB"]
        StateBucket["S3 Bucket\nvery-prince-terraform-state\n(KMS SSE, versioning,\nSSL-only bucket policy)"]
        LockTable["DynamoDB Table\nvery-prince-terraform-locks\n(Pay-per-request,\nLockID hash key,\nPITR + SSE)"]
        State --- StateBucket
        State --- LockTable
        
        subgraph DataProtection["Data Protection"]
            EBRule["EventBridge Rule\nvery-prince-shared-prune-schedule"]
            PruneLambda["Lambda Function\nvery-prince-shared-prune-snapshots"]
            Snapshots["Manual RDS DB / Cluster\nSnapshots"]
        end
    end
    
    Jenkins["Jenkins Pipeline\nBuild → Trivy scan → Terraform"] -->|terraform apply| State
    Jenkins -->|docker build + push| BackendImage["Backend image\nvery-prince-backend:$BUILD_NUMBER"]
    Jenkins -->|docker build + push| FrontendImage["Frontend image\nvery-prince-frontend:$BUILD_NUMBER"]
    BackendImage -->|Trivy: fail on HIGH/CRITICAL CVEs| SecurityGate{"Security gate"}
    SecurityGate -->|pass| Service
    Browser["Browser"] -->|HTTPS /_next/static/*| CDN["CloudFront\nGlobal edge network"]
    CDN -->|OAC SigV4| Assets["Private S3 asset bucket\n_next/static/* only"]
    Service -->|awslogs driver| CWLogs
    CWLogs -->|metric filters| CWDashboard
    CWAlerts -->|alarm actions| SNSTopic
    SNSTopic -->|email| Email
    Jenkins -->|deploy| Service
```

## Terraform State Management

The very-prince Terraform state lives in Amazon S3 and is protected against
concurrent writes by a DynamoDB-backed lock table. The same root module
provisions both resources on the first bootstrap run, then subsequent plans
and applies read/write state remotely with serialized locking.

### Resources

| Resource | Type | Name | Notes |
|---|---|---|---|
| State bucket | `aws_s3_bucket` | `very-prince-terraform-state` | Versioning enabled, KMS SSE with bucket key, public access fully blocked |
| Bucket policy | `aws_s3_bucket_policy` | (attached to state bucket) | Denies any `s3:*` action when `aws:SecureTransport = false` |
| Lock table | `aws_dynamodb_table` | `very-prince-terraform-locks` | `PAY_PER_REQUEST`, `LockID` (String) hash key, PITR + SSE enabled |

### Bootstrap workflow (first-time only)

The S3 backend references resources that this same Terraform configuration
creates, so a one-time bootstrap is required before `init` can talk to S3:

1. Comment out the `backend "s3" { ... }` block in `terraform/backend.tf`.
2. From the `terraform/` directory, run:
   - `terraform init -backend=false -input=false`
   - `terraform apply -auto-approve -input=false`
3. Uncomment the backend block in `terraform/backend.tf`.
4. Run the platform-appropriate bootstrap script:
   - **Linux/macOS/WSL**: `scripts/bootstrap-terraform-backend.sh`
   - **Native Windows (PowerShell)**: `scripts/bootstrap-terraform-backend.ps1`

These scripts verify the bucket and DynamoDB table exist, then run
`terraform init -migrate-state -input=false -force-copy` followed by a
`plan`/`apply` cycle with `-lock=true -lock-timeout=300s` to prove that
DynamoDB locking is enforced on every run.

### Locking semantics

- Terraform acquires a lock on the `LockID` row in the DynamoDB table before
  any state read/write.
- Concurrent `terraform apply` invocations fail fast with a lock error
  rather than corrupting the state file.
- Jenkins passes `-lock=true` to every `plan` and `apply`, so the lock is
  always asserted during CI/CD execution.
- Lock TTL is 300 seconds; if a prior run crashed, `terraform force-unlock`
  may be used to release the lock.

### Outputs

| Output | Description |
|---|---|
| `state_bucket_arn` / `state_bucket_name` | Reference the state S3 bucket |
| `dynamodb_lock_table_name` / `dynamodb_lock_table_arn` | Reference the lock table |
| `state_backend_type` | Returns `"s3"` |
| `state_locking_enabled` | Returns `true` |

## Components

### ECS Cluster (`terraform/modules/ecs-cluster/`)
- Fargate + Fargate Spot capacity providers
- Container Insights enabled for enhanced metrics
- Tagged with Project/Environment

### ECS Service (`terraform/modules/ecs-service/`)
- Task definition with `awslogs` log driver → CloudWatch Logs
- Execution role: CloudWatch Logs write + ECR pull, scoped to this service's own log group and ECR repository (no wildcard resources except `ecr:GetAuthorizationToken`, which AWS requires as account-level/`*`)
- Task role: Least-privilege application permissions
- Network: Private subnets + security group
- Optional ALB target group attachment

### CloudWatch Logs (`terraform/modules/cloudwatch-logs/`)
- Log group: `/ecs/very-prince-backend`
- 30-day retention (configurable)
- KMS encryption (AWS-managed)

### CloudWatch Alarms (`terraform/modules/cloudwatch-alarms/`)
- **CPU High**: `CPUUtilization ≥ 80%` for 2 × 60s periods
- **Memory High**: `MemoryUtilization ≥ 80%` for 2 × 60s periods
- Both route to SNS topic for notification

### CloudWatch Dashboard (`terraform/modules/cloudwatch-dashboard/`)
- Cluster CPU/Memory (stacked)
- Service CPU/Memory (lines)
- Task counts (running/pending/desired)
- Log ingestion volume & bytes

### SNS Topics (`terraform/modules/sns-topics/`)
- Topic: `very-prince-shared-critical-alerts`
- Email subscriptions from `alert_email_addresses` variable
- CloudWatch alarm publishing policy

### Asset CDN (`terraform/modules/asset-cdn/`)
- CloudFront distribution using every edge location (`PriceClass_All` by default) to minimize global static-asset latency
- CloudFront Origin Access Control (SigV4) for a private S3 origin; no S3 public access is required
- Bucket policy permits CloudFront read access only to `/_next/static/*` and only from this distribution
- `_next/static/*` uses a dedicated cache policy with a fixed one-year TTL. These paths contain Next.js content-hashed, immutable bundles.
- All other paths use a zero-TTL fallback, so immutable caching cannot be applied accidentally to mutable content.

### RDS Snapshot Lifecycle (`terraform/modules/rds-snapshot-lifecycle/`)
- **Purpose**: prune orphaned manual RDS DB snapshots and DB cluster snapshots that are older than the configured retention period to reduce storage costs.
- **Trigger**: EventBridge rule (`very-prince-shared-prune-schedule`) on the `rds_snapshot_prune_schedule` expression (default `rate(1 day)`).
- **Compute**: Python 3.11 Lambda (`very-prince-shared-prune-snapshots`) that paginates through `DescribeDBSnapshots` and `DescribeDBClusterSnapshots` with `SnapshotType = "manual"`, compares `SnapshotCreateTime` to the retention cutoff, and calls `DeleteDBSnapshot` / `DeleteDBClusterSnapshot`.
- **IAM**: least-privilege inline policy only (no AWS-managed policy attachments). `rds:DescribeDBSnapshots`/`rds:DescribeDBClusterSnapshots` use `Resource: "*"` because RDS does not support resource-level permissions for Describe actions; `rds:DeleteDBSnapshot`/`rds:DeleteDBClusterSnapshot` are scoped to this account/region's `snapshot:*` and `cluster-snapshot:*` ARNs respectively, and CloudWatch Logs permissions are scoped to this function's own `/aws/lambda/...` log group.
- **Configuration as code**:
  - `rds_snapshot_retention_days` (default `7`) — days to keep manual snapshots
  - `rds_backup_window` (default `03:00-04:00`) — preferred UTC backup window captured as code
  - `rds_snapshot_prune_schedule` (default `rate(1 day)`) — EventBridge schedule expression for pruning

## Data Flow

1. ECS tasks emit stdout/stderr → `awslogs` driver → CloudWatch Log Group
2. CloudWatch collects ECS CPU/Memory metrics automatically (Container Insights)
3. Alarms evaluate metrics every 60s; trigger SNS on threshold breach
4. SNS delivers to email subscribers (and any HTTPS/Lambda endpoints added manually)
5. Dashboard visualizes all metrics in single pane
6. Browser requests for `/_next/static/*` are served from the nearest CloudFront edge; cache misses are signed and fetched from the private S3 origin.
7. Jenkins builds `packages/backend/Dockerfile` as `very-prince-backend:$BUILD_NUMBER` and scans that exact local image with Trivy before Terraform can apply changes.
8. EventBridge invokes the snapshot pruning Lambda on its configured schedule; the Lambda deletes manual RDS snapshots older than `rds_snapshot_retention_days`.

## Jenkins Pipeline (`Jenkinsfile`)
- Declarative syntax
- Stages: Setup → Build Docker Image → Scan Docker Image → **Init** → **Verify Backend Lock** → Validate → Plan → Apply (gated)
- The image build uses `packages/backend/Dockerfile` and is tagged `very-prince-backend:$BUILD_NUMBER`.
- Trivy runs `trivy image --exit-code 1 --severity HIGH,CRITICAL` against the compiled image. Any High or Critical CVE makes the scan command return a non-zero status, stopping the pipeline before Terraform apply/deployment.
- OS detection: `isUnix()` → `sh` on Linux, `bat` on Windows. Jenkins agents require native Docker and Trivy CLIs on their `PATH`.
- Artifact: `tfplan` passed between Plan/Apply
- Build/deploy steps (tool setup, `terraform init`/`validate`/`plan`/`apply`, Docker build, Trivy scan) are abstracted into reusable functions in `jenkins-shared-library/vars/*.groovy`, used by both this pipeline and `Jenkinsfile.rds-snapshot-lifecycle`. They're loaded today via the `load()` step (no Jenkins admin action required); see `jenkins-shared-library/README.md` for the follow-up to extract this into a dedicated repository and register it as a Jenkins Global Pipeline Library (`@Library`).

## Windows Support
- `scripts/terraform-setup.ps1`: Chocolatey/Scoop/Zip install
- No WSL required
- Jenkins pipeline uses `bat` on Windows agents
- The CDN module uses only the Terraform AWS provider and runs with the native Windows Terraform CLI; WSL is not required.
- The RDS snapshot lifecycle module and its dedicated Jenkinsfile use only native `terraform.exe` / `terraform` commands; WSL is not required.
- `jenkins-shared-library/vars/*.groovy` steps branch on `isUnix()` the same way the Jenkinsfiles did before extraction, so Windows agents still run `bat`/`terraform.exe` natively; no WSL dependency was introduced.

## CDN Configuration

Set `asset_bucket_name` to the existing private S3 bucket that receives the Next.js build output. Upload immutable bundles beneath `_next/static/`; the module intentionally grants CloudFront access only to that prefix. Use the `cloudfront_distribution_domain_name` Terraform output as the asset host (for example, as the Next.js `assetPrefix` origin) when deploying the frontend.

## Operations

### Accessing Dashboard
```
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=very-prince-shared-very-prince-backend
```

### Alarm Names
- `very-prince-very-prince-backend-cpu-high`
- `very-prince-very-prince-backend-memory-high`

### SNS Topic
- `very-prince-shared-critical-alerts`

### Log Group
- `/ecs/very-prince-backend`

### RDS Snapshot Lifecycle
- Lambda function: `very-prince-shared-prune-snapshots`
- EventBridge rule: `very-prince-shared-prune-schedule`
- Lambda IAM role: `very-prince-shared-snapshot-prune-role`

# Very-Prince Infrastructure Architecture

## Overview

This document describes the AWS infrastructure provisioned via Terraform for the very-prince backend service and its Next.js static-asset CDN. The infrastructure enables CloudWatch log aggregation, metric alarms, dashboards, SNS alert notifications for an ECS Fargate cluster, durable SQS webhook dispatch with dead-letter handling, global delivery of immutable frontend bundles, and automated lifecycle management for RDS snapshots.

```mermaid
flowchart TD
    subgraph AWS["AWS us-east-1"]
        subgraph VPC["VPC"]
            subgraph Private["Private Subnets"]
                ECS["ECS Fargate Cluster\n(Container Insights Enabled)"]
                Service["ECS Service\nvery-prince-backend"]
                Task["Fargate Tasks\n(CPU: 512, Mem: 1024 MiB)"]
            end
            
            subgraph Monitoring["Monitoring"]
                CWLogs["CloudWatch Log Group\n/ecs/very-prince-backend"]
                CWDashboard["CloudWatch Dashboard"]
                CWAlerts["CloudWatch Alarms\nCPU ≥ 80%, Memory ≥ 80%"]
                SNSTopic["SNS Topic\nvery-prince-shared-critical-alerts"]
                Email["Email Subscriptions"]
            end
        end
        
        State["Terraform State\nS3 + DynamoDB"]
        StateBucket["S3 Bucket\nvery-prince-terraform-state\n(KMS SSE, versioning,\nSSL-only bucket policy)"]
        LockTable["DynamoDB Table\nvery-prince-terraform-locks\n(Pay-per-request,\nLockID hash key,\nPITR + SSE)"]
        WebhookQueue["SQS Queue\nwebhook-dispatch"]
        WebhookDLQ["SQS DLQ\nwebhook-dispatch-dlq"]
        State --- StateBucket
        State --- LockTable
        WebhookQueue -->|redrive after retries| WebhookDLQ
        
        subgraph DataProtection["Data Protection"]
            EBRule["EventBridge Rule\nvery-prince-shared-prune-schedule"]
            PruneLambda["Lambda Function\nvery-prince-shared-prune-snapshots"]
            Snapshots["Manual RDS DB / Cluster\nSnapshots"]
        end
    end
    
    Jenkins["Jenkins Pipeline\nBuild → Trivy scan → Terraform"] -->|terraform apply| State
    Jenkins -->|docker build| Image["Backend image\nvery-prince-backend:$BUILD_NUMBER"]
    Image -->|Trivy: fail on HIGH/CRITICAL CVEs| SecurityGate{"Security gate"}
    SecurityGate -->|pass| Service
    Browser["Browser"] -->|HTTPS /_next/static/*| CDN["CloudFront\nGlobal edge network"]
    CDN -->|OAC SigV4| Assets["Private S3 asset bucket\n_next/static/* only"]
    Service -->|awslogs driver| CWLogs
    Service -->|enqueue/poll/delete| WebhookQueue
    Service -->|final failure envelope| WebhookDLQ
    CWLogs -->|metric filters| CWDashboard
    CWAlerts -->|alarm actions| SNSTopic
    WebhookDLQ -->|depth alarm| CWAlerts
    SNSTopic -->|email| Email
    Jenkins -->|deploy| Service
```

## Terraform State Management

The very-prince Terraform state lives in Amazon S3 and is protected against
concurrent writes by a DynamoDB-backed lock table. The same root module
provisions both resources on the first bootstrap run, then subsequent plans
and applies read/write state remotely with serialized locking.

### Resources

| Resource | Type | Name | Notes |
|---|---|---|---|
| State bucket | `aws_s3_bucket` | `very-prince-terraform-state` | Versioning enabled, KMS SSE with bucket key, public access fully blocked |
| Bucket policy | `aws_s3_bucket_policy` | (attached to state bucket) | Denies any `s3:*` action when `aws:SecureTransport = false` |
| Lock table | `aws_dynamodb_table` | `very-prince-terraform-locks` | `PAY_PER_REQUEST`, `LockID` (String) hash key, PITR + SSE enabled |

### Bootstrap workflow (first-time only)

The S3 backend references resources that this same Terraform configuration
creates, so a one-time bootstrap is required before `init` can talk to S3:

1. Comment out the `backend "s3" { ... }` block in `terraform/backend.tf`.
2. From the `terraform/` directory, run:
   - `terraform init -backend=false -input=false`
   - `terraform apply -auto-approve -input=false`
3. Uncomment the backend block in `terraform/backend.tf`.
4. Run the platform-appropriate bootstrap script:
   - **Linux/macOS/WSL**: `scripts/bootstrap-terraform-backend.sh`
   - **Native Windows (PowerShell)**: `scripts/bootstrap-terraform-backend.ps1`

These scripts verify the bucket and DynamoDB table exist, then run
`terraform init -migrate-state -input=false -force-copy` followed by a
`plan`/`apply` cycle with `-lock=true -lock-timeout=300s` to prove that
DynamoDB locking is enforced on every run.

### Locking semantics

- Terraform acquires a lock on the `LockID` row in the DynamoDB table before
  any state read/write.
- Concurrent `terraform apply` invocations fail fast with a lock error
  rather than corrupting the state file.
- Jenkins passes `-lock=true` to every `plan` and `apply`, so the lock is
  always asserted during CI/CD execution.
- Lock TTL is 300 seconds; if a prior run crashed, `terraform force-unlock`
  may be used to release the lock.

### Outputs

| Output | Description |
|---|---|
| `state_bucket_arn` / `state_bucket_name` | Reference the state S3 bucket |
| `dynamodb_lock_table_name` / `dynamodb_lock_table_arn` | Reference the lock table |
| `state_backend_type` | Returns `"s3"` |
| `state_locking_enabled` | Returns `true` |

## Components

### ECS Cluster (`terraform/modules/ecs-cluster/`)
- Fargate + Fargate Spot capacity providers, configured via `aws_ecs_cluster_capacity_providers`
- Container Insights enabled for enhanced metrics
- Tagged with Project/Environment
- Strict `name` validation (non-empty, ≤255 chars, starts with a letter, alphanumeric/hyphen/underscore only)

### Fargate Task Definition (`terraform/modules/fargate-task/`)
- Strict, declarative `aws_ecs_task_definition` module used by `ecs-service`
- Enforces Fargate compatibility: `network_mode = "awsvpc"`, `requires_compatibilities = ["FARGATE"]`
- Validates CPU, memory, OS family, and CPU architecture at the variable layer
- Supports optional task role and required execution role

### ECS Service (`terraform/modules/ecs-service/`)
- Task definition with `awslogs` log driver → CloudWatch Logs
- Execution role: CloudWatch Logs write + ECR pull (via `AmazonECSTaskExecutionRolePolicy` managed policy)
- Task role: Least-privilege application permissions (empty inline policy by default; attach application-specific policies externally)
- Network: Private subnets + security group; no public IP assignment
- Optional ALB target group attachment
- Deployment circuit breaker with automatic rollback

#### IAM Roles Created by `ecs-service` Module

| Role | Name Pattern | Trust Policy | Attached Policies | Purpose |
|---|---|---|---|---|
| Execution Role | `{service-name}-execution-role` | `ecs-tasks.amazonaws.com` | `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy` | Allows ECS agent to pull container images from ECR and write task logs to CloudWatch Logs |
| Task Role | `{service-name}-task-role` | `ecs-tasks.amazonaws.com` | None (empty inline policy) | Assumed by the running application container; attach least-privilege policies for AWS API access (e.g., SSM Parameter Store, Secrets Manager) via external `aws_iam_role_policy` resources |

### Strict Module Validation

All ECS-related Terraform modules validate inputs at the variable layer to prevent invalid resource configurations:

- `ecs-cluster`: `name` must be non-empty, ≤255 characters, start with a letter, and contain only letters, digits, hyphens, and underscores.
- `fargate-task`: `cpu` and `memory` must be Fargate-supported values; `network_mode` must be `awsvpc`; `requires_compatibilities` must include `FARGATE`; `operating_system_family` and `cpu_architecture` must be ECS-supported values.
- `ecs-service`: `container_port` must be in the range 1–65535.

These validations fail `terraform plan` early, before any AWS API call, so misconfigurations surface during code review rather than at apply time.

### CloudWatch Logs (`terraform/modules/cloudwatch-logs/`)
- Log group: `/ecs/very-prince-backend`
- 30-day retention (configurable)
- KMS encryption (AWS-managed)

### CloudWatch Alarms (`terraform/modules/cloudwatch-alarms/`)
- **CPU High**: `CPUUtilization ≥ 80%` for 2 × 60s periods
- **Memory High**: `MemoryUtilization ≥ 80%` for 2 × 60s periods
- **Webhook DLQ Depth High**: `ApproximateNumberOfMessagesVisible ≥ 1` for the webhook DLQ
- Both route to SNS topic for notification

### Webhook SQS Queue (`terraform/modules/sqs-webhook-queue/`)
- Source queue: `${project_name}-${environment}-webhook-dispatch`
- Dead-letter queue: `${project_name}-${environment}-webhook-dispatch-dlq`
- SQS-managed server-side encryption enabled on both queues
- Redrive policy sends messages to the DLQ after `webhook_queue_max_receive_count` failed receives
- ECS tasks receive/delete source queue messages and publish final failure envelopes to the DLQ for manual inspection

### CloudWatch Dashboard (`terraform/modules/cloudwatch-dashboard/`)
- Cluster CPU/Memory (stacked)
- Service CPU/Memory (lines)
- Task counts (running/pending/desired)
- Log ingestion volume & bytes

### SNS Topics (`terraform/modules/sns-topics/`)
- Topic: `very-prince-shared-critical-alerts`
- Email subscriptions from `alert_email_addresses` variable
- CloudWatch alarm publishing policy

### Asset CDN (`terraform/modules/asset-cdn/`)
- CloudFront distribution using every edge location (`PriceClass_All` by default) to minimize global static-asset latency
- CloudFront Origin Access Control (SigV4) for a private S3 origin; no S3 public access is required
- Bucket policy permits CloudFront read access only to `/_next/static/*` and only from this distribution
- `_next/static/*` uses a dedicated cache policy with a fixed one-year TTL. These paths contain Next.js content-hashed, immutable bundles.
- All other paths use a zero-TTL fallback, so immutable caching cannot be applied accidentally to mutable content.

### RDS Snapshot Lifecycle (`terraform/modules/rds-snapshot-lifecycle/`)
- **Purpose**: prune orphaned manual RDS DB snapshots and DB cluster snapshots that are older than the configured retention period to reduce storage costs.
- **Trigger**: EventBridge rule (`very-prince-shared-prune-schedule`) on the `rds_snapshot_prune_schedule` expression (default `rate(1 day)`).
- **Compute**: Python 3.11 Lambda (`very-prince-shared-prune-snapshots`) that paginates through `DescribeDBSnapshots` and `DescribeDBClusterSnapshots` with `SnapshotType = "manual"`, compares `SnapshotCreateTime` to the retention cutoff, and calls `DeleteDBSnapshot` / `DeleteDBClusterSnapshot`.
- **IAM**: least-privilege inline policy (`rds:DescribeDBSnapshots`, `rds:DescribeDBClusterSnapshots`, `rds:DeleteDBSnapshot`, `rds:DeleteDBClusterSnapshot`) plus CloudWatch Logs permissions.
- **Configuration as code**:
  - `rds_snapshot_retention_days` (default `7`) — days to keep manual snapshots
  - `rds_backup_window` (default `03:00-04:00`) — preferred UTC backup window captured as code
  - `rds_snapshot_prune_schedule` (default `rate(1 day)`) — EventBridge schedule expression for pruning

## Data Flow

1. ECS tasks emit stdout/stderr → `awslogs` driver → CloudWatch Log Group
2. CloudWatch collects ECS CPU/Memory metrics automatically (Container Insights)
3. Alarms evaluate metrics every 60s; trigger SNS on threshold breach
4. SNS delivers to email subscribers (and any HTTPS/Lambda endpoints added manually)
5. Dashboard visualizes all metrics in single pane
6. Browser requests for `/_next/static/*` are served from the nearest CloudFront edge; cache misses are signed and fetched from the private S3 origin.
 main
HEAD
7. Jenkins builds and pushes `packages/backend/Dockerfile` as `ghcr.io/.../very-prince-backend:$BUILD_NUMBER` and `packages/frontend/Dockerfile` as `ghcr.io/.../very-prince-frontend:$BUILD_NUMBER`, scanning the backend image with Trivy before Terraform can apply changes.

7. Jenkins builds `packages/backend/Dockerfile` as `very-prince-backend:$BUILD_NUMBER` and scans that exact local image with Trivy before Terraform can apply changes.
8. EventBridge invokes the snapshot pruning Lambda on its configured schedule; the Lambda deletes manual RDS snapshots older than `rds_snapshot_retention_days`.
 d8a8e63db1f830d044a2fd34ad48bce8b00e2ae8

7. Webhook events enqueue to SQS and are deleted only after successful delivery. Failed receives remain available for retry; exhausted messages are copied to the DLQ with failure metadata, with native SQS redrive as a fallback.
8. Jenkins builds `packages/backend/Dockerfile` as `very-prince-backend:$BUILD_NUMBER` and scans that exact local image with Trivy before Terraform can apply changes.
9. EventBridge invokes the snapshot pruning Lambda on its configured schedule; the Lambda deletes manual RDS snapshots older than `rds_snapshot_retention_days`.
 main

## Jenkins Pipeline (`Jenkinsfile`)

- Declarative syntax
- Stages: Setup → Build Docker Image → Scan Docker Image → **Init** → **Verify Backend Lock** → Validate → Plan → Apply (gated)
- The image build uses `packages/backend/Dockerfile` and is tagged `very-prince-backend:$BUILD_NUMBER`.
- Trivy runs `trivy image --exit-code 1 --severity HIGH,CRITICAL` against the compiled image. Any High or Critical CVE makes the scan command return a non-zero status, stopping the pipeline before Terraform apply/deployment.
- OS detection: `isUnix()` → `sh` on Linux, `bat` on Windows. Jenkins agents require native Docker and Trivy CLIs on their `PATH`.
- Artifact: `tfplan` passed between Plan/Apply
- Build/deploy steps (tool setup, `terraform init`/`validate`/`plan`/`apply`, Docker build, Trivy scan) are abstracted into reusable functions in `jenkins-shared-library/vars/*.groovy`, used by both this pipeline and `Jenkinsfile.rds-snapshot-lifecycle`. They're loaded today via the `load()` step (no Jenkins admin action required); see `jenkins-shared-library/README.md` for the follow-up to extract this into a dedicated repository and register it as a Jenkins Global Pipeline Library (`@Library`).
- Stages:
  1. **Setup** — verify tool versions (Terraform, AWS CLI, Docker, Trivy)
  2. **Build & Push Images** — **parallel** backend + frontend builds using `docker buildx build` with BuildKit registry cache; both images pushed to `ghcr.io/bridgetthnkechi87-cloud/`
  3. **Scan Backend Image** — Trivy scans the backend image for HIGH/CRITICAL CVEs; failure blocks the pipeline
  4. **Init** — `terraform init` with explicit backend config
  5. **Verify Backend Lock** — probes DynamoDB lock table to confirm backend reachability
  6. **Validate** — `terraform validate`
  7. **Plan** — `terraform plan -lock=true -lock-timeout=300s -out=tfplan`
  8. **Apply** — gated on `main` branch with manual approval; applies the stashed plan

### BuildKit Registry Caching

The pipeline preserves BuildKit layer caches across Jenkins agents by pushing and pulling a dedicated **cache image** to the container registry:

| Variable | Value | Purpose |
|---|---|---|
| `BUILDKIT_CACHE_REF_BACKEND`  | `ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:buildcache` | Backend build cache |
| `BUILDKIT_CACHE_REF_FRONTEND` | `ghcr.io/bridgetthnkechi87-cloud/very-prince-frontend:buildcache` | Frontend build cache |

Each `docker buildx build` invocation uses:
```
--cache-from=type=registry,ref=<CACHE_REF>
--cache-to=type=registry,ref=<CACHE_REF>,mode=max
--push
```

The `mode=max` exports all layers (including intermediate build stages) so subsequent builds on **any** agent can reuse them. The local workspace is also preserved on success (see `post { success }`), so the agent-local BuildKit cache directory survives between runs as a secondary cache layer.

### Dockerfile Build Caching Strategy

Both `packages/backend/Dockerfile` and `packages/frontend/Dockerfile` use a 6-stage (backend) / 5-stage (frontend) multistage build with BuildKit cache mounts:

1. **base** — shared Alpine + native dependencies (`libc6-compat`, `openssl`)
2. **pruner** — Turbo prunes the monorepo to the target workspace + deps
3. **deps** — `npm ci` with `--mount=type=cache,target=/root/.npm,id=npm-cache`; **no application source is copied**, so this layer is invalidated only when `package-lock.json` changes
4. **builder** — copies source, generates Prisma client (backend) / runs Next.js build (frontend); cache mounts for `/app/node_modules/.cache`, per-package `.turbo`, and npm cache keep compilations warm
5. **prod-deps** (backend only) — `npm prune --omit=dev` inside npm cache mount; strips Prisma engines and devDependencies
6. **runner** — minimal runtime: non-root user, compiled output, pruned `node_modules` (backend) or Next.js standalone bundle (frontend)

**Layer invalidation guarantees:**
- Source-only changes (e.g., `packages/backend/src/**`) do **not** invalidate the `deps` stage
- Only `package.json` / `package-lock.json` changes re-run `npm ci`
- Cache mounts (`/root/.npm`, `node_modules/.cache`, `.turbo`) are keyed by BuildKit and reused across builds on the same agent; the registry cache (`:buildcache` image) provides the same reuse across agents

### Security Scanning

- Trivy runs `trivy image --exit-code 1 --severity HIGH,CRITICAL` against the **pushed** backend image reference.
- The scan stage executes **after** the parallel build and **before** any Terraform stage, ensuring vulnerable images never reach deployment.
- Frontend images are not scanned by default; add a parallel `Scan Frontend Image` stage if required.

 HEAD
### State Locking in CI

The `Init` stage calls `terraform init` with explicit `-backend-config`
flags so the S3 bucket, DynamoDB lock table, region, and `encrypt=true`
settings are always passed to the backend (matching the values in
`terraform/backend.tf`):

```
terraform init \
  -input=false \
  -backend-config="bucket=${STATE_BUCKET_NAME}" \
  -backend-config="dynamodb_table=${DYNAMODB_LOCK_TABLE}" \
  -backend-config="region=${AWS_DEFAULT_REGION}" \
  -backend-config="encrypt=true"
```

Immediately after `Init`, the `Verify Backend Lock` stage probes the
DynamoDB lock table by running `terraform force-unlock -force
nonexistent-lock-id`. Terraform contacts the configured lock table and
returns an error referencing the missing lock. The stage asserts that
the output contains the word `lock` (case-insensitive) — this proves the
S3 backend and DynamoDB lock table are both reachable from the Jenkins
agent. The stage intentionally tolerates the non-zero exit code from
`force-unlock`; only the absence of the word `lock` in the output fails
the build.

Both `Plan` and `Apply` use `-lock=true -lock-timeout=300s` so every CI
run asserts DynamoDB-side locks during execution.

### Local Development with `docker-bake.hcl`

The `docker-bake.hcl` file at the repo root provides a single-command
multi-platform build that uses the same registry cache refs as CI:

```bash
# Build both images (pushes to registry, requires auth)
docker buildx bake

# Build locally without pushing (loads into local Docker daemon)
docker buildx bake --set "*.output=type=docker"

# Build only backend
docker buildx bake backend

# Override tag
docker buildx bake --set "*.tags=myregistry/very-prince-backend:v1.2.3"
```

Cache refs in `docker-bake.hcl` align with the Jenkins environment variables:
- Backend: `ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:buildcache`
- Frontend: `ghcr.io/bridgetthnkechi87-cloud/very-prince-frontend:buildcache`

 d8a8e63db1f830d044a2fd34ad48bce8b00e2ae8
## Windows Support

- `scripts/terraform-setup.ps1`: Installs Terraform on native Windows via Chocolatey, Scoop, or direct zip download. No WSL or Linux subsystem is required.
- `scripts/bootstrap-terraform-backend.ps1`: Native Windows bootstrap equivalent of `scripts/bootstrap-terraform-backend.sh`; migrates local state to S3 + DynamoDB using `terraform.exe` directly.
- The Jenkins pipeline uses `bat` steps on Windows agents and `sh` steps on Unix agents.
- All Terraform modules use only the AWS provider and run with the native Windows Terraform CLI; WSL is not required.
- `jenkins-shared-library/vars/*.groovy` steps branch on `isUnix()` the same way the Jenkinsfiles did before extraction, so Windows agents still run `bat`/`terraform.exe` natively; no WSL dependency was introduced.
- `scripts/terraform-setup.ps1`: Chocolatey/Scoop/Zip install
- No WSL required
- Jenkins pipeline uses `bat` on Windows agents
- The CDN module uses only the Terraform AWS provider and runs with the native Windows Terraform CLI; WSL is not required.
- The RDS snapshot lifecycle module and its dedicated Jenkinsfile use only native `terraform.exe` / `terraform` commands; WSL is not required.

## CDN Configuration

Set `asset_bucket_name` to the existing private S3 bucket that receives the Next.js build output. Upload immutable bundles beneath `_next/static/`; the module intentionally grants CloudFront access only to that prefix. Use the `cloudfront_distribution_domain_name` Terraform output as the asset host (for example, as the Next.js `assetPrefix` origin) when deploying the frontend.

## Operations

### Accessing Dashboard
```
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=very-prince-shared-very-prince-backend
```

### Alarm Names
- `very-prince-very-prince-backend-cpu-high`
- `very-prince-very-prince-backend-memory-high`
- `very-prince-very-prince-backend-webhook-dlq-depth-high`

### SNS Topic
- `very-prince-shared-critical-alerts`

### Log Group
 HEAD
- `/ecs/very-prince-backend`
- `/ecs/very-prince-backend`

### RDS Snapshot Lifecycle
- Lambda function: `very-prince-shared-prune-snapshots`
- EventBridge rule: `very-prince-shared-prune-schedule`
- Lambda IAM role: `very-prince-shared-snapshot-prune-role`
main
 d8a8e63db1f830d044a2fd34ad48bce8b00e2ae8


 main
