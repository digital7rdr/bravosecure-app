import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor, BadRequestException,
} from '@nestjs/common';
import type {Request} from 'express';
import {Observable, of} from 'rxjs';
import {tap, switchMap} from 'rxjs/operators';
import {createHash} from 'node:crypto';
import {RedisService} from '../../redis/redis.service';
import type {AccessClaims} from '../../auth/jwt.service';
import type {AdminContext} from '../../ops/admin.guard';

const PREFIX = 'idem:';
const TTL_SEC = 24 * 60 * 60;          // 24 hours per audit fix 4.3
const KEY_MIN = 8;
const KEY_MAX = 128;
// Regex matches typical client-side UUID v4 / nanoid / base64url ids.
const KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Audit fix 4.3 — Idempotency-Key interceptor.
 *
 * Apply to handlers that perform a non-idempotent state transition
 * (approve, dispatch, complete, ack, decide, terminate). The client
 * MUST send `Idempotency-Key: <opaque>` (8–128 chars, [A-Za-z0-9_-]).
 * A replay within 24h returns the cached response from the first call;
 * the underlying handler is never invoked twice.
 *
 * Cache key: `idem:<sha256(admin_id + ':' + method + ' ' + route + ':' + key)>`.
 * Scoped to the admin so two admins can't collide on the same key value,
 * and to (method, route) so an idempotent GET key doesn't poison a POST.
 *
 * Failure modes:
 *   - missing header   → 400 (opt-in is explicit per call)
 *   - bad shape        → 400 (catches accidental typos before they cache)
 *   - non-serializable response → not cached (replay misses, re-executes)
 *   - thrown exception → not cached (so the client can retry the same key)
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request & {user?: AccessClaims; admin?: AdminContext}>();
    const header = req.header('idempotency-key') ?? req.header('Idempotency-Key');
    if (!header) {
      throw new BadRequestException('idempotency_key_required');
    }
    if (header.length < KEY_MIN || header.length > KEY_MAX || !KEY_RE.test(header)) {
      throw new BadRequestException('idempotency_key_invalid_shape');
    }

    const actor = req.admin?.user_id ?? req.user?.sub ?? 'anon';
    const route = `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`;
    // Hash inside Redis so an attacker who reads the cache can't see
    // customer-provided keys. Recomputable per request from headers +
    // req.admin, so no decode is needed on read.
    const cacheKey = PREFIX + createHash('sha256')
      .update(`${actor}:${route}:${header}`)
      .digest('hex');

    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      try {
        return of(JSON.parse(cached));
      } catch {
        // Corrupt cache row — drop it and re-run the handler.
        await this.redis.client.del(cacheKey);
      }
    }

    return next.handle().pipe(
      switchMap(async (result) => {
        try {
          const serialized = JSON.stringify(result ?? null);
          await this.redis.client.set(cacheKey, serialized, 'EX', TTL_SEC);
        } catch {
          // Non-serializable response — first call already executed, so
          // we return the result but skip caching. A replay will miss
          // and re-execute the handler.
        }
        return result;
      }),
      tap({error: () => {
        // Thrown handler errors are intentionally NOT cached — the client
        // should be able to retry with the same key after a 500.
      }}),
    );
  }
}

/** Helper for tests / non-NestJS callers — same key derivation as the interceptor. */
export function computeIdempotencyCacheKey(actor: string, method: string, route: string, key: string): string {
  return PREFIX + createHash('sha256')
    .update(`${actor}:${method.toUpperCase()} ${route}:${key}`)
    .digest('hex');
}
