variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, production)"
}

variable "region" {
  type        = string
  description = "AWS region"
  default     = "sa-east-1"
}
