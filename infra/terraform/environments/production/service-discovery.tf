# -----------------------------------------------------------------------------
# Cloud Map — private DNS namespace for service discovery
# -----------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "ibatexas.local"
  vpc  = data.aws_vpc.default.id

  tags = {
    Environment = var.environment
  }
}
