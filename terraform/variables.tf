variable "aws_region" {
  description = "AWS region for the main infrastructure"
  type        = string
  default     = "eu-west-1" # Ireland — lowest latency to Netherlands
}

variable "domain_name" {
  description = "Full domain name for the app"
  type        = string
  default     = "ov.jarryd.co.za"
}

variable "route53_zone_name" {
  description = "Route53 hosted zone name (parent domain)"
  type        = string
  default     = "jarryd.co.za"
}

variable "app_name" {
  description = "Application name — used as prefix for all resource names"
  type        = string
  default     = "komt-ie"
}

variable "ecs_cpu" {
  description = "ECS task CPU units (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "ecs_memory" {
  description = "ECS task memory in MB"
  type        = number
  default     = 512
}

variable "backend_port" {
  description = "Port the backend Node.js server listens on"
  type        = number
  default     = 3001
}
