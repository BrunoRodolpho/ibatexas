import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend(event) {
    // Strip request cookies and auth headers
    if (event.request) {
      if (event.request.cookies) event.request.cookies = {};
      if (event.request.headers) {
        const { authorization, cookie, ...safeHeaders } = event.request.headers as Record<string, string>;
        void authorization; void cookie;
        event.request.headers = safeHeaders;
      }
    }
    // Strip user PII
    if (event.user) {
      const { email, ip_address, ...safeUser } = event.user;
      void email; void ip_address;
      event.user = safeUser;
    }
    return event;
  },
});
