# ─────────────────────────────────────────────────────────────────────────────
# ECS Service module — Task Definition (strict, via fargate-task)
# ─────────────────────────────────────────────────────────────────────────────
#
# The task definition is delegated to the strict `fargate-task` module so all
# validation (cpu, memory, network_mode, OS family, architecture) is enforced
# at the type level. This file only composes the container definitions payload
# and wires the service to that task definition. IAM roles are defined in
# iam.tf.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  container_environment = concat(
    [
      {
        name  = "AWS_REGION"
        value = var.aws_region
      },
    ],
    var.webhook_queue_url == "" ? [] : [
      {
        name  = "WEBHOOK_QUEUE_PROVIDER"
        value = "sqs"
      },
      {
        name  = "WEBHOOK_QUEUE_URL"
        value = var.webhook_queue_url
      },
      {
        name  = "WEBHOOK_QUEUE_MAX_RECEIVE_COUNT"
        value = tostring(var.webhook_queue_max_receive_count)
      },
      {
        name  = "WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS"
        value = tostring(var.webhook_queue_visibility_timeout_seconds)
      },
    ],
    var.webhook_dlq_url == "" ? [] : [
      {
        name  = "WEBHOOK_DLQ_ENABLED"
        value = "true"
      },
      {
        name  = "WEBHOOK_DLQ_URL"
        value = var.webhook_dlq_url
      },
    ],
  )

  container_definitions = jsonencode([
    {
      name      = var.name
      image     = var.image_uri
      cpu       = var.task_cpu
      memory    = var.task_memory
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
      environment = local.container_environment
    }
  ])
}

module "task_definition" {
  source = "../fargate-task"

  family                   = var.name
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  container_definitions    = local.container_definitions
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  operating_system_family  = "LINUX"
  cpu_architecture         = "X86_64"

  tags = var.tags
}

# ─────────────────────────────────────────────────────────────────────────────
# ECS Service
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_service" "backend" {
  name            = var.name
  cluster         = var.cluster_id
  task_definition = module.task_definition.task_definition_arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  deployment_controller {
    type = "ECS"
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.service_sg_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn != "" ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = var.tags
}
