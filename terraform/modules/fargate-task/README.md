# fargate-task

Strict, declarative `aws_ecs_task_definition` module for AWS Fargate.

## What it creates

| Resource                   | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `aws_ecs_task_definition`  | Fargate-compatible task definition with runtime platform pinning |

## Inputs

| Variable                   | Type        | Default               | Notes                          |
| -------------------------- | ----------- | --------------------- | ------------------------------ |
| `family`                   | string      | (required)            | Task definition family name    |
| `cpu`                      | string      | `"512"`               | Fargate-supported CPU units    |
| `memory`                   | string      | `"1024"`              | Fargate-supported MiB          |
| `container_definitions`    | string      | (required)            | JSON payload                   |
| `execution_role_arn`       | string      | (required)            | ECR + CloudWatch Logs role     |
| `task_role_arn`            | string      | `""`                  | Application IAM role           |
| `requires_compatibilities` | list(string)| `["FARGATE"]`         | Must contain `FARGATE`         |
| `network_mode`             | string      | `"awsvpc"`            | `awsvpc` required for Fargate |
| `operating_system_family`  | string      | `"LINUX"`             | ECS-supported OS               |
| `cpu_architecture`         | string      | `"X86_64"`            | `X86_64` or `ARM64`            |
| `tags`                     | map(string) | `{}`                  | Resource tags                  |

## Validation

All variables are validated:

- `cpu` and `memory` must match Fargate-supported values.
- `network_mode` must be `awsvpc`.
- `requires_compatibilities` must contain `FARGATE`.
- `cpu_architecture` must be `X86_64` or `ARM64`.
- `operating_system_family` must be a supported ECS value.

## Usage

```hcl
module "task" {
  source = "./modules/fargate-task"

  family             = "very-prince-backend"
  cpu                = "512"
  memory             = "1024"
  execution_role_arn = module.ecs_service.execution_role_arn
  task_role_arn      = module.ecs_service.task_role_arn

  container_definitions = jsonencode([{
    name      = "very-prince-backend"
    image     = var.image_uri
    cpu       = 512
    memory    = 1024
    essential = true
    portMappings = [{
      containerPort = 3001
      hostPort      = 3001
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/very-prince-backend"
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = {
    Project     = "very-prince"
    Environment = "production"
  }
}
```

## Outputs

| Output                      | Description                          |
| --------------------------- | ------------------------------------ |
| `task_definition_arn`       | Full ARN including revision          |
| `task_definition_family`    | Family name without revision         |
| `task_definition_revision`  | Numeric revision                     |
| `container_definitions`     | Container definitions JSON           |