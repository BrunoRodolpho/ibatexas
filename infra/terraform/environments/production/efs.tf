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
  description = "Allow NFS from Typesense + NATS ECS tasks"
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

# -----------------------------------------------------------------------------
# EFS — persistent storage for the NATS JetStream store (/data)
#
# Fargate has no host disk, so without this the JetStream store_dir lives on
# ephemeral task storage and is wiped on every task replacement — silently
# downgrading at-least-once to at-most-once. This mirrors the Typesense EFS
# wiring above so the store survives redeploys.
# -----------------------------------------------------------------------------

resource "aws_efs_file_system" "nats" {
  creation_token = "ibatexas-${var.environment}-nats"
  encrypted      = true

  tags = {
    Name        = "ibatexas-${var.environment}-nats"
    Environment = var.environment
  }
}

resource "aws_efs_mount_target" "nats" {
  for_each = toset(data.aws_subnets.default.ids)

  file_system_id  = aws_efs_file_system.nats.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "nats" {
  file_system_id = aws_efs_file_system.nats.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/jetstream-data"
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

resource "aws_vpc_security_group_ingress_rule" "efs_from_nats" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.nats.id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}
