# -----------------------------------------------------------------------------
# Network data sources — default VPC + AL2023 ARM64 AMI
# -----------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

# Pick AZs that support t4g.small (Graviton). us-east-1e famously has no
# Graviton capacity; we filter subnets by AZ against this list.
data "aws_ec2_instance_type_offerings" "graviton_azs" {
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
  location_type = "availability-zone"
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.graviton_azs.locations
  }
}

# Latest Amazon Linux 2023 AMI — picks arch automatically based on instance type.
# Using SSM parameter so the AMI ID auto-updates on recreation.
data "aws_ssm_parameter" "al2023_arm64" {
  name = startswith(var.instance_type, "t4g") || startswith(var.instance_type, "m7g") || startswith(var.instance_type, "c7g") ? "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" : "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_caller_identity" "current" {}
