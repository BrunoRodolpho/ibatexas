# -----------------------------------------------------------------------------
# EFS — persistent storage for Typesense index data
# -----------------------------------------------------------------------------

resource "aws_efs_file_system" "typesense" {
  creation_token = "ibatexas-${var.environment}-typesense"
  encrypted      = true

  tags = {
    Name        = "ibatexas-${var.environment}-typesense"
    Environment = var.environment
  }
}

resource "aws_efs_mount_target" "typesense" {
  for_each = toset(data.aws_subnets.default.ids)

  file_system_id  = aws_efs_file_system.typesense.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "typesense" {
  file_system_id = aws_efs_file_system.typesense.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/typesense-data"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = {
    Environment = var.environment
  }
}

# --- EFS Security Group ---

resource "aws_security_group" "efs" {
  name        = "ibatexas-${var.environment}-efs"
  description = "Allow NFS from Typesense ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name        = "ibatexas-${var.environment}-efs"
    Environment = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_typesense" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.typesense.id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}
