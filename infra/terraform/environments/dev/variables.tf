variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, production)"
}

variable "region" {
  type        = string
  description = "AWS region"
  default     = "sa-east-1"
}

variable "domain_name" {
  type        = string
  description = "Root domain name"
  default     = "ibatexas.com.br"
}

variable "api_image_tag" {
  type        = string
  description = "Docker image tag for the API service"
  default     = "latest"
}

variable "web_image_tag" {
  type        = string
  description = "Docker image tag for the Web service"
  default     = "latest"
}

variable "admin_image_tag" {
  type        = string
  description = "Docker image tag for the Admin service"
  default     = "latest"
}
