# networking

Declarative Terraform module for AWS VPC, subnets, NAT gateways, Application Load Balancer, and security groups required by a Fargate ECS service.

## Resources

| Resource                       | Description                                                  |
| ------------------------------ | ------------------------------------------------------------ |
| `aws_vpc`                      | VPC with DNS hostnames + DNS support enabled                |
| `aws_internet_gateway`         | Internet gateway for public subnets                         |
| `aws_subnet` (public)          | Public subnets (map_public_ip_on_launch = true)             |
| `aws_subnet` (private)         | Private subnets (no public IP)                              |
| `aws_eip`                      | Elastic IPs for NAT gateways (one per AZ)                   |
| `aws_nat_gateway`              | NAT gateway per AZ in the public subnet                      |
| `aws_route_table` (public)     | Public route: `0.0.0.0/0 → IGW`                            |
| `aws_route_table` (private)    | Private route: `0.0.0.0/0 → NAT` (one per AZ)               |
| `aws_security_group` (ALB)    | Ingress: `80`, `443` from `0.0.0.0/0`                      |
| `aws_security_group` (ECS)    | Ingress: `container_port` from `aws_security_group.alb.id`  |
| `aws_lb`                       | Application Load Balancer (internet-facing)                  |
| `aws_lb_target_group`          | ALB target group (`ip` target type, HTTP health check)      |
| `aws_lb_listener`              | ALB listener: `80 → ${target_group}`                        |

## Usage

```hcl
module "networking" {
  source = "./modules/networking"

  name                = "my-project"
  vpc_cidr           = "10.0.0.0/16"
  availability_zones  = ["us-east-1a", "us-east-1b"]
  container_port      = 3001
  health_check_path   = "/health"

  tags = {
    Project     = "my-project"
    Environment = "production"
  }
}
```

## Outputs

| Output                        | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `vpc_id`                      | ID of the created VPC                          |
| `public_subnet_ids`           | IDs of the public subnets                      |
| `private_subnet_ids`          | IDs of the private subnets                     |
| `ecs_tasks_security_group_id` | SG for Fargate tasks (ingress from ALB)        |
| `alb_security_group_id`      | SG for the ALB                                 |
| `alb_arn`                     | ARN of the ALB                                 |
| `target_group_arn`            | ARN of the ALB target group                    |

## Native Windows

Run `terraform.exe` in PowerShell or `cmd.exe`. No WSL required.
`terraform-setup.ps1` installs the Terraform CLI on Windows.