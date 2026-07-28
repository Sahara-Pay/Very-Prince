# ecs-service

Declarative Terraform module for an AWS ECS service running on Fargate. The task definition is delegated to the strict `fargate-task` sub-module so all validation (cpu, memory, network_mode, OS family, architecture) is enforced at the type level. This module composes the container definitions payload and wires the service to that task definition.

## What it creates

| Resource | Description |
|----------|-------------|
| `aws_ecs_service` | Fargate ECS service with circuit breaker/rollback, private subnet placement, optional ALB target group |
| `aws_iam_role` (execution) | IAM role for ECS to pull images and write CloudWatch logs |
| `aws_iam_role` (task) | IAM role for the running task to call AWS APIs (least-privilege) |
| `module.task_definition` | Strict Fargate task definition via `../fargate-task` |

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5.0 |
| aws | ~> 4.0 |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| name | ECS service name | string | n/a | yes |
| cluster_id | ECS cluster ID | string | n/a | yes |
| cluster_name | ECS cluster name | string | n/a | yes |
| log_group_name | CloudWatch log group name for awslogs driver | string | n/a | yes |
| image_uri | Docker image URI | string | n/a | yes |
| task_cpu | Task CPU units (1024 = 1 vCPU) | number | 512 | no |
| task_memory | Task memory in MiB | number | 1024 | no |
| desired_count | Desired number of tasks | number | 2 | no |
| private_subnet_ids | Private subnet IDs for ECS service placement | list(string) | n/a | yes |
| service_sg_id | Security group ID for tasks | string | n/a | yes |
| target_group_arn | Optional ALB target group ARN | string | "" | no |
| container_port | Container port to expose | number | 3001 | no |
| aws_region | AWS region | string | n/a | yes |
| tags | Tags to apply | map(string) | {} | no |

## Outputs

| Name | Description |
|------|-------------|
| service_name | Name of the ECS service |
| service_arn | ARN of the ECS service |
| task_definition_arn | Full ARN of the task definition including revision |
| task_definition_family | Family name without revision |
| task_definition_revision | Numeric revision of the task definition |

## Usage

```hcl
module "ecs_service" {
  source             = "./modules/ecs-service"
  name               = "very-prince-backend"
  cluster_id         = module.ecs_cluster.cluster_id
  cluster_name       = module.ecs_cluster.cluster_name
  log_group_name     = module.cloudwatch_logs.log_group_name
  image_uri          = var.image_uri
  task_cpu           = var.task_cpu
  task_memory        = var.task_memory
  desired_count      = var.desired_count
  private_subnet_ids = module.networking.private_subnet_ids
  service_sg_id      = module.networking.ecs_tasks_security_group_id
  target_group_arn   = module.networking.target_group_arn
  aws_region         = var.aws_region

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
```