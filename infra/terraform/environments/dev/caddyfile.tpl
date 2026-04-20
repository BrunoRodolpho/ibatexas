{
	email admin@{$DOMAIN}
	# Logs to stdout, inherited by docker logs via the caddy container.
	log {
		output stdout
		format json
		level INFO
	}
}

# Root domain → web (Next.js storefront)
{$DOMAIN} {
	encode zstd gzip
	reverse_proxy web:3000
}

# api.<domain> → Fastify API
api.{$DOMAIN} {
	encode zstd gzip
	reverse_proxy api:3001
}

# admin.<domain> → admin dashboard
admin.{$DOMAIN} {
	encode zstd gzip
	reverse_proxy admin:3002
}
