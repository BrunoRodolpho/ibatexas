# -----------------------------------------------------------------------------
# ALB — Internet-facing load balancer with HTTPS + host-based routing
# -----------------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "ibatexas-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = {
    Environment = var.environment
  }
}

# --- Target Groups ---

resource "aws_lb_target_group" "api" {
  name                 = "ibatexas-${var.environment}-api"
  port                 = 3001
  protocol             = "HTTP"
  vpc_id               = data.aws_vpc.default.id
  target_type          = "ip"
  deregistration_delay = 120

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "web" {
  name                 = "ibatexas-${var.environment}-web"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = data.aws_vpc.default.id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    path                = "/"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "admin" {
  name                 = "ibatexas-${var.environment}-admin"
  port                 = 3002
  protocol             = "HTTP"
  vpc_id               = data.aws_vpc.default.id
  target_type          = "ip"
  deregistration_delay = 30

  # Next.js admin returns 307 redirecting "/" → "/admin"; accept 200-399 as healthy.
  health_check {
    path                = "/"
    protocol            = "HTTP"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Environment = var.environment
  }
}

# --- HTTPS Listener (443) with host-based routing ---

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  # Default action → web (storefront)
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# api.ibatexas.com.br → api target group
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = ["api.${var.domain_name}"]
    }
  }
}

# admin.ibatexas.com.br → admin target group
resource "aws_lb_listener_rule" "admin" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.admin.arn
  }

  condition {
    host_header {
      values = ["admin.${var.domain_name}"]
    }
  }
}

# --- HTTP Listener (80) — redirect to HTTPS ---

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
