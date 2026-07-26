# ─────────────────────────────────────────────────────────────────────────────
# Networking module — Outputs
# ─────────────────────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "ID of the created VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "CIDR block of the created VPC."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (ALB placement)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets (ECS Fargate tasks)."
  value       = aws_subnet.private[*].id
}

output "ecs_tasks_security_group_id" {
  description = "ID of the security group assigned to ECS Fargate tasks (ingress from ALB only)."
  value       = aws_security_group.ecs_tasks.id
}

output "alb_security_group_id" {
  description = "ID of the security group assigned to the ALB."
  value       = aws_security_group.alb.id
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.main.arn
}

output "alb_dns_name" {
  description = "DNS name of the ALB (for CNAME or route53 alias)."
  value       = aws_lb.main.dns_name
}

output "alb_sg_id" {
  description = "Alias: same as alb_security_group_id (pass to ecs-service)."
  value       = aws_security_group.alb.id
}

output "target_group_arn" {
  description = "ARN of the ALB target group (for ECS service attachment)."
  value       = aws_lb_target_group.main.arn
}

output "nat_gateway_ips" {
  description = "EIPs allocated to each NAT gateway per availability zone."
  value       = aws_eip.nat[*].public_ip
}