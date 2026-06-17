# Rendered by terraform templatefile() with account_id, region, domain and
# baked into user_data. Compose-level variable substitution references env_file
# values like REDIS_PASSWORD using the $${} form (double-dollar in this .tpl
# becomes single-dollar once terraform renders it).

name: ibatexas

services:
  caddy:
    image: caddy:2-alpine
    container_name: ibatexas-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/ibatexas/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    env_file: /opt/ibatexas/.env
    environment:
      DOMAIN: ${domain}
    depends_on:
      - web
      - api
      - admin
      - commerce
    networks: [ibatexas]

  api:
    image: ${account_id}.dkr.ecr.${region}.amazonaws.com/ibatexas-api:latest
    container_name: ibatexas-api
    restart: unless-stopped
    env_file: /opt/ibatexas/.env
    environment:
      NODE_ENV: production
      APP_ENV: dev
      PORT: "3001"
      TRUST_PROXY: "true"
      RESTAURANT_TIMEZONE: America/Sao_Paulo
      # At-least-once migration: dev runs the durable-JetStream path (streams
      # provisioned at boot; subscribers use manual ack/nak/term → real
      # redelivery + DLQ; publishes get a PubAck). Dev persists JetStream to the
      # named docker volume nats_data:/data; prod persists it to EFS
      # (aws_efs_access_point.nats — see production/{efs,nats}.tf).
      # See ~/projects/jetstream-at-least-once-plan.md.
      NATS_JETSTREAM_ENABLED: "true"
      # typesense-js expects a bare hostname here (protocol + port are separate
      # fields on the client). Passing a full URL makes DNS try to resolve
      # "http" as a host — see packages/tools/src/typesense/client.ts.
      TYPESENSE_HOST: typesense
      TYPESENSE_PORT: "8108"
      TYPESENSE_PROTOCOL: http
    depends_on:
      - redis
      - nats
      - typesense
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 512M

  web:
    image: ${account_id}.dkr.ecr.${region}.amazonaws.com/ibatexas-web:latest
    container_name: ibatexas-web
    restart: unless-stopped
    env_file: /opt/ibatexas/.env
    environment:
      NODE_ENV: production
      APP_ENV: dev
      PORT: "3000"
      # Next.js standalone reads HOSTNAME to pick the bind address. Docker sets
      # HOSTNAME to the container ID by default, which makes the server bind to
      # eth0 only (reachable from Caddy, NOT from `localhost` in the same
      # container), so the in-container healthcheck `wget localhost:3000/` gets
      # ECONNREFUSED and the container goes unhealthy.
      HOSTNAME: "0.0.0.0"
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 192M

  admin:
    image: ${account_id}.dkr.ecr.${region}.amazonaws.com/ibatexas-admin:latest
    container_name: ibatexas-admin
    restart: unless-stopped
    env_file: /opt/ibatexas/.env
    environment:
      NODE_ENV: production
      APP_ENV: dev
      PORT: "3002"
      HOSTNAME: "0.0.0.0"
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 192M

  commerce:
    image: ${account_id}.dkr.ecr.${region}.amazonaws.com/ibatexas-commerce:latest
    container_name: ibatexas-commerce
    restart: unless-stopped
    env_file: /opt/ibatexas/.env
    environment:
      NODE_ENV: production
      APP_ENV: dev
      PORT: "9000"
      # shared = single process handles both HTTP and background workers.
      # Splitting into `server` + `worker` is a future optimization when we
      # need to scale background jobs independently.
      MEDUSA_WORKER_MODE: shared
      # Cap Node heap to just under the cgroup limit so V8 GCs aggressively
      # instead of OOMing at boot when Medusa loads all modules.
      NODE_OPTIONS: "--max-old-space-size=450"
    depends_on:
      - redis
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 512M

  redis:
    image: redis:7-alpine
    container_name: ibatexas-redis
    restart: unless-stopped
    # Compose loads /opt/ibatexas/.env automatically (same dir as docker-compose.yml)
    # and substitutes $${REDIS_PASSWORD} below at compose-up time.
    command: ["redis-server", "--requirepass", "$${REDIS_PASSWORD}"]
    env_file: /opt/ibatexas/.env
    volumes:
      - redis_data:/data
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 160M

  nats:
    image: nats:2.11-alpine
    container_name: ibatexas-nats
    restart: unless-stopped
    # T3-10: server-side auth — the server REFUSES unauthenticated clients.
    # The config file is written by user_data from the repo's
    # infra/nats/nats-server.app.conf; NATS_APP_NKEY_PUBLIC is interpolated by
    # compose from /opt/ibatexas/.env (auto-loaded; populated from SSM by
    # ibatexas-refresh-secrets — push NATS_NKEY_SEED + NATS_APP_NKEY_PUBLIC
    # via `ibx infra secrets:push` BEFORE deploying). Side effect: jetstream
    # now actually persists to the mounted /data volume (the old bare `-js`
    # used the in-container default store dir).
    command: ["-c", "/etc/nats/nats-server.conf"]
    environment:
      NATS_APP_NKEY_PUBLIC: $${NATS_APP_NKEY_PUBLIC:?push NATS_APP_NKEY_PUBLIC to SSM via ibx infra secrets:push (T3-10 NATS auth)}
    volumes:
      - /opt/ibatexas/nats-server.conf:/etc/nats/nats-server.conf:ro
      - nats_data:/data
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 96M

  typesense:
    image: typesense/typesense:27.1
    container_name: ibatexas-typesense
    restart: unless-stopped
    command:
      - --data-dir
      - /data
      - --api-key=$${TYPESENSE_BOOTSTRAP_KEY}
      - --enable-cors
    env_file: /opt/ibatexas/.env
    volumes:
      - typesense_data:/data
    networks: [ibatexas]
    deploy:
      resources:
        limits:
          memory: 256M

networks:
  ibatexas:
    driver: bridge

volumes:
  caddy_data:
  caddy_config:
  redis_data:
  nats_data:
  typesense_data:
