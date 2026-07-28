# ecs-cluster

Declarative Terraform module for an AWS ECS cluster configured for Fargate workloads.

## What it creates

| Resource | Description |
|----------|-------------|
| `aws_ecs_cluster` | ECS cluster with Container Insights enabled |
| `aws_ecs_cluster_capacity_providers` | Associates FARGATE and FARGATE_SPOT capacity providers; sets a default strategy (FARGATE, weight=1, base=1) |

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5.0 |
| aws | ~> 4.0 |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| name | ECS cluster name (must be non-empty, ≤255 chars, start with a letter, contain only letters, digits, hyphens, underscores) | string | n/a | yes |
| tags | Tags to apply to cluster resources | map(string) | {} | no |

## Outputs

| Name | Description |
|------|-------------|
| cluster_id | ECS cluster ID |
| cluster_name | ECS cluster name |
| cluster_arn | ECS cluster ARN |

## Usage

```hcl
module "ecs_cluster" {
  source = "./modules/ecs-cluster"
  name   = "very-prince"

  tags = {
    Project     = "very-prince"
    Environment = "shared"
  }
}
```