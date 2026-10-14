import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';

// Local Vite dev server. Override with CORS_ORIGIN (comma-separated list).
const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Number of reverse proxies in front of the API (TRUST_PROXY). Unset or 0:
// the client IP is the socket address. Only a hop count is accepted, never
// "true", so a client cannot spoof X-Forwarded-For to evade rate limits.
export function trustedProxyHops(): number {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  return Number.isInteger(hops) && hops > 0 && hops <= 5 ? hops : 0;
}

// Defensive headers for a JSON API (equivalent to helmet's relevant subset,
// without adding a dependency). Responses carry session-scoped inventory data,
// so they must not be cached by browsers or intermediaries.
function securityHeaders(_request: Request, response: Response, next: NextFunction) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
  next();
}

// Shared by main.ts and the e2e tests so both validate requests identically.
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  const hops = trustedProxyHops();
  if (hops > 0) express.set('trust proxy', hops);

  app.use(securityHeaders);

  // The token travels in the Authorization header; no cookies are used.
  app.enableCors({
    origin: corsOrigins(),
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
}
