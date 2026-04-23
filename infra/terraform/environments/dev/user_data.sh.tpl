#!/bin/bash
# ibatexas dev host — bootstrap script.
# Runs once on first boot (AL2023 cloud-init). Subsequent boots re-run
# `ibatexas.service` which invokes `ibatexas-deploy`.
#
# Template variables (substituted by Terraform):
#   ${region}, ${account_id}, ${environment}, ${domain}, ${ecr_registry},
#   ${secret_names} (JSON array)
set -euo pipefail

exec > >(tee -a /var/log/ibatexas-bootstrap.log) 2>&1

echo "[bootstrap] starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Packages ---
dnf -y update
dnf -y install docker jq awscli

# --- Swap (2 GB) to backstop OOM during image pulls/boots ---
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Docker ---
systemctl enable --now docker
# Install compose v2 plugin (AL2023 repo ships standalone, not plugin).
mkdir -p /usr/local/lib/docker/cli-plugins
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) COMPOSE_ARCH="aarch64" ;;
  x86_64)        COMPOSE_ARCH="x86_64" ;;
  *)             echo "[bootstrap] unknown arch $ARCH"; exit 1 ;;
esac
COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$COMPOSE_ARCH"
curl -fsSL "$COMPOSE_URL" -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# --- Directory layout ---
mkdir -p /opt/ibatexas
cd /opt/ibatexas

# --- Write compose.yml (already rendered by terraform templatefile) ---
cat > /opt/ibatexas/docker-compose.yml <<'COMPOSE_EOF'
${compose_yml}
COMPOSE_EOF

# --- Write Caddyfile ---
cat > /opt/ibatexas/Caddyfile <<'CADDY_EOF'
${caddyfile}
CADDY_EOF

# --- Helper: refresh secrets from SSM Parameter Store → .env ---
cat > /usr/local/bin/ibatexas-refresh-secrets <<'REFRESH_EOF'
#!/bin/bash
set -euo pipefail

REGION="${region}"
ENV="${environment}"
ENV_FILE="/opt/ibatexas/.env"

umask 077
: > "$ENV_FILE.new"

# Fetch everything under /ibatexas/<env>/
next=""
while true; do
  if [ -z "$next" ]; then
    page=$(aws ssm get-parameters-by-path \
      --path "/ibatexas/$ENV/" \
      --with-decryption \
      --region "$REGION" \
      --output json)
  else
    page=$(aws ssm get-parameters-by-path \
      --path "/ibatexas/$ENV/" \
      --with-decryption \
      --region "$REGION" \
      --starting-token "$next" \
      --output json)
  fi

  echo "$page" | jq -r '.Parameters[] | "\(.Name | sub("^/ibatexas/[^/]+/"; ""))=\(.Value)"' >> "$ENV_FILE.new"

  next=$(echo "$page" | jq -r '.NextToken // empty')
  [ -z "$next" ] && break
done

# Add auto-populated infra values that aren't in SSM.
# NEXT_PUBLIC_* values are also baked into the client bundle at image-build
# time (see .github/workflows/deploy-staging.yml build-args). Keeping them in
# the runtime .env too ensures next.config.mjs generates a matching CSP
# header at server boot — otherwise the CSP would fall back to localhost:3001
# and block the real api.<domain> origin.
{
  echo "DOMAIN=${domain}"
  echo "NEXT_PUBLIC_API_URL=https://api.${domain}"
  echo "NEXT_PUBLIC_APP_URL=https://${domain}"
  echo "NEXT_PUBLIC_MEDUSA_BACKEND_URL=https://api.${domain}"
  echo "MEDUSA_BACKEND_URL=https://api.${domain}"
  echo "MEDUSA_URL=https://api.${domain}"
  echo "APP_BASE_URL=https://${domain}"
  echo "WEB_URL=https://${domain}"
  # CORS_ORIGIN must include every browser origin that calls the API with
  # credentials. Web and admin are both separate subdomains from the API.
  echo "CORS_ORIGIN=https://${domain},https://admin.${domain}"
  echo "APP_ENV=${environment}"
} >> "$ENV_FILE.new"

mv "$ENV_FILE.new" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
echo "[refresh-secrets] wrote $(wc -l < $ENV_FILE) lines to $ENV_FILE"
REFRESH_EOF
chmod +x /usr/local/bin/ibatexas-refresh-secrets

# --- Helper: deploy (ECR login + pull + up) ---
cat > /usr/local/bin/ibatexas-deploy <<'DEPLOY_EOF'
#!/bin/bash
set -euo pipefail

REGION="${region}"
REGISTRY="${ecr_registry}"
COMPOSE="/opt/ibatexas/docker-compose.yml"

echo "[deploy] logging in to ECR"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "[deploy] refreshing secrets"
/usr/local/bin/ibatexas-refresh-secrets

echo "[deploy] pulling images"
docker compose -f "$COMPOSE" pull

echo "[deploy] starting services"
docker compose -f "$COMPOSE" up -d --remove-orphans

echo "[deploy] pruning old images"
docker image prune -f

echo "[deploy] current state:"
docker compose -f "$COMPOSE" ps
DEPLOY_EOF
chmod +x /usr/local/bin/ibatexas-deploy

# --- systemd unit ---
cat > /etc/systemd/system/ibatexas.service <<'UNIT_EOF'
[Unit]
Description=ibatexas application stack
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/ibatexas-deploy
ExecStop=/usr/bin/docker compose -f /opt/ibatexas/docker-compose.yml down
TimeoutStartSec=600
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable ibatexas.service

# First start — run in background so cloud-init can finish.
# If it fails on first boot because secrets haven't been pushed yet, the next
# SSM Run Command (ibx infra secrets:push) will bring it up.
systemctl start ibatexas.service || {
  echo "[bootstrap] ibatexas.service failed first start — secrets may not be set yet"
  journalctl -u ibatexas.service --no-pager | tail -50
}

echo "[bootstrap] complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
