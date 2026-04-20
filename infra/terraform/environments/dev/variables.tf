variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, production)"
}

variable "region" {
  type        = string
  description = "AWS region"
  default     = "us-east-1"
}

variable "domain_name" {
  type        = string
  description = "Root domain name"
  default     = "ibatexas.com.br"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo in org/repo format for OIDC trust"
  default     = "BrunoRodolpho/ibatexas"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type — ARM Graviton for cost. t4g.small = 2 vCPU / 2 GB."
  default     = "t4g.small"
}

variable "ebs_size_gb" {
  type        = number
  description = "Root EBS volume size in GB"
  default     = 30
}

variable "ssh_cidr" {
  type        = string
  description = "CIDR to allow SSH from (empty string = port 22 closed; prefer SSM Session Manager)"
  default     = ""
}
