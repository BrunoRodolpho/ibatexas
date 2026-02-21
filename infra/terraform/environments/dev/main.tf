terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state — configure before first apply
  # backend "s3" {
  #   bucket         = "ibatexas-terraform-state"
  #   key            = "dev/terraform.tfstate"
  #   region         = "sa-east-1"
  #   dynamodb_table = "ibatexas-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
}
