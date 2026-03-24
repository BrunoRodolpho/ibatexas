# -----------------------------------------------------------------------------
# ElastiCache — Redis 7 (single-node, dev-simple: no TLS, no AUTH)
# -----------------------------------------------------------------------------

resource "aws_elasticache_parameter_group" "redis7" {
  name   = "ibatexas-${var.environment}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "ibatexas-${var.environment}"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Environment = var.environment
  }
}

resource "aws_elasticache_cluster" "this" {
  cluster_id           = "ibatexas-${var.environment}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = aws_elasticache_parameter_group.redis7.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.redis.id]
  port                 = 6379

  tags = {
    Environment = var.environment
  }
}

# Auto-populate REDIS_URL secret with ElastiCache endpoint
resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.this["REDIS_URL"].id
  secret_string = "redis://${aws_elasticache_cluster.this.cache_nodes[0].address}:6379"
}

# --- Redis Security Group ---

resource "aws_security_group" "redis" {
  name        = "ibatexas-${var.environment}-redis"
  description = "Allow Redis from ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name        = "ibatexas-${var.environment}-redis"
    Environment = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
