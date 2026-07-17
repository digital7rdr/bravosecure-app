import 'reflect-metadata';
import {NestFactory}          from '@nestjs/core';
import {ValidationPipe}       from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {AppModule}            from './app.module';
import {join}                 from 'node:path';
import {mkdirSync}            from 'node:fs';

async function bootstrap(): Promise<void> {
  // Auth audit P0-A9 — refuse to start in production with any of the
  // OTP / biometric dev-bypass envs set. Those flags exist for local
  // development (e.g. let the OTP code be `123456` so emulator tests
  // run without Twilio). A typo in a Helm chart or a stale `.env`
  // rsync'd to prod silently flips the entire OTP + biometric gate
  // off; the only signal today is a `logger.warn` line nobody
  // monitors. Fail-fast here matches the pattern already in place
  // for `CORS_ALLOWED_ORIGINS` below.
  if (process.env.NODE_ENV === 'production') {
    const dangerous = [
      'OTP_DEV_BYPASS',
      'BIOMETRIC_DEV_BYPASS',
      'OTP_DEV_RETURN_CODE',
      'DISPATCH_TRUST_MOCKED_LOCATION',
      'DISPATCH_DISABLE_REGION_FILTER',
    ];
    const enabled = dangerous.filter(k => process.env[k] === 'true');
    if (enabled.length > 0) {
      throw new Error(
        `refusing_to_start: dev bypass flags set in production: ${enabled.join(', ')}`,
      );
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
    // Stripe webhook needs the raw bytes to verify the HMAC signature.
    // Nest v10 exposes req.rawBody when this flag is set.
    rawBody: true,
  });

  // Global validation — strip unknown properties, transform types.
  // Audit fix 1.4 — forbidNonWhitelisted rejects extra fields (catches
  // typos AND attempts to smuggle privileged fields like `role` /
  // `subscription_tier` into endpoints whose DTOs don't accept them).
  //
  // Rolled out staged via STRICT_VALIDATION env: `true` in staging (and
  // any dev shell that opts in) returns 400 on unknown fields; default /
  // `false` keeps the old whitelist-and-strip behavior so an in-flight
  // mobile build sending a stale field doesn't suddenly start failing
  // in prod. Flip to `true` in prod only after the canary confirms no
  // 400 spike on /auth/*, /bookings/*, /ops/*.
  const strictValidation = process.env.STRICT_VALIDATION === 'true';
  app.useGlobalPipes(new ValidationPipe({
    whitelist:            true,
    forbidNonWhitelisted: strictValidation,
    transform:            true,
  }));

  // Trusts the X-Forwarded-For header (behind Kong / load balancer).
  app.set('trust proxy', true);

  // Audit fix 0.4 — minimal cookie parser. Avoids adding `cookie-parser`
  // as a dep just to read 1-2 cookies. Express 4 doesn't expose req.cookies
  // by default. Skips CORS preflights (no cookies travel on OPTIONS) and
  // tolerates malformed `%`-sequences — without the try/catch, an attacker
  // who plants `bravo_ops_token=%XX` via a cross-site <img> would crash
  // every subsequent request through this middleware.
  app.use((req: Express.Request & {cookies?: Record<string, string>}, _res: unknown, next: () => void) => {
    const method = (req as unknown as {method?: string}).method;
    if (method === 'OPTIONS') {
      req.cookies = {};
      return next();
    }
    const header = (req as unknown as {headers: Record<string, string | undefined>}).headers.cookie;
    const out: Record<string, string> = {};
    if (typeof header === 'string') {
      for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (!k) continue;
        try {
          out[k] = decodeURIComponent(v);
        } catch {
          // Malformed percent-encoding — keep the raw value rather than
          // throwing and 500'ing the request. Downstream guards compare
          // cookie equality, so a corrupt value just fails the check.
          out[k] = v;
        }
      }
    }
    req.cookies = out;
    next();
  });

  // Audit fix 0.4 + 1.6 — explicit CORS origin allowlist.
  //
  // The previous default (`origin: true`) reflected back any Origin header,
  // which combined with `credentials: true` is the well-known footgun: an
  // attacker page on evil.com can ride along on the user's session via
  // CORS-with-credentials. We now refuse the request unless the Origin is
  // in the configured list.
  //
  // CORS_ALLOWED_ORIGINS is a comma-separated env var of allowed origins,
  // e.g. "https://ops.bravosecure.com,https://app.bravosecure.com".
  // In dev it can be left empty or set to "*" to fall back to non-credentialed
  // wildcard mode (origin reflection is still disabled in that branch — the
  // browser sees `Access-Control-Allow-Origin: *` only when not sending
  // credentials, so the cookie session won't work but a Bearer-token client
  // — i.e. mobile — still does).
  const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const wildcard = corsOrigins.includes('*');
  if (corsOrigins.length === 0 && process.env.NODE_ENV === 'production') {
    // Fail-closed in prod — refusing to start beats silently allowing
    // every origin. A misconfigured deploy never reaches the CSRF gate.
    throw new Error('CORS_ALLOWED_ORIGINS must be set in production');
  }
  app.enableCors({
    origin:         wildcard ? '*' : (corsOrigins.length > 0 ? corsOrigins : false),
    credentials:    !wildcard,    // wildcard + credentials is rejected by browsers
    exposedHeaders: ['X-CSRF-Token'],
  });

  // Serve uploaded files (KYC + compliance-pack docs) so the ops-console
  // can render <a href="http://host:3001/uploads/…"> links.
  const uploadsDir = join(process.cwd(), 'uploads');
  mkdirSync(uploadsDir, {recursive: true});
  app.useStaticAssets(uploadsDir, {prefix: '/uploads/'});

  // Step 26 — run onModuleDestroy on SIGTERM so the Redis-locked watchdog/SLO/
  // reconciliation sweeps clear their timers cleanly on a rolling deploy.
  app.enableShutdownHooks();

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port, '0.0.0.0');
  console.log(
    `[auth-service] Listening on :${port} ` +
    `(strict_validation=${strictValidation}, cors_origins=${wildcard ? '*' : corsOrigins.join(',') || 'none'})`,
  );
}

void bootstrap();
