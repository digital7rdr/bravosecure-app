import {BadRequestException, type CallHandler, type ExecutionContext} from '@nestjs/common';
import {of, firstValueFrom, type Observable} from 'rxjs';
import {IdempotencyInterceptor} from './idempotency.interceptor';
import type {RedisService} from '../../redis/redis.service';

const client = {get: jest.fn(), set: jest.fn(), del: jest.fn()};
const redis = {client} as unknown as RedisService;

function reqWith(idempotencyKey?: string): Record<string, unknown> {
  const headers: Record<string, string | undefined> = {'idempotency-key': idempotencyKey};
  return {
    header: (n: string) => headers[n.toLowerCase()],
    method: 'post',
    route: {path: '/dispatch/offers/:id/accept'},
    user: {sub: 'mgr-1'},
  };
}

function ctxFor(req: unknown): ExecutionContext {
  return {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): {handler: CallHandler; calls: () => number} {
  const handle = jest.fn(() => of(value) as Observable<unknown>);
  return {handler: {handle} as unknown as CallHandler, calls: () => handle.mock.calls.length};
}

describe('IdempotencyInterceptor', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    client.set.mockResolvedValue('OK');
    client.del.mockResolvedValue(1);
  });

  it('400s when the Idempotency-Key header is missing (acceptance f)', async () => {
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith(undefined)), handlerReturning({}).handler))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s on a malformed key (too short / illegal chars)', async () => {
    const i = new IdempotencyInterceptor(redis);
    await expect(i.intercept(ctxFor(reqWith('short')), handlerReturning({}).handler)).rejects.toBeInstanceOf(BadRequestException);
    await expect(i.intercept(ctxFor(reqWith('has spaces and !!')), handlerReturning({}).handler)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('on a cache MISS runs the handler once and caches the result', async () => {
    client.get.mockResolvedValue(null);
    const {handler, calls} = handlerReturning({offer_id: 'o1', status: 'CONFIRMED'});
    const i = new IdempotencyInterceptor(redis);
    const result = await firstValueFrom(await i.intercept(ctxFor(reqWith('accept-offer-1')), handler));
    expect(result).toEqual({offer_id: 'o1', status: 'CONFIRMED'});
    expect(calls()).toBe(1);
    expect(client.set).toHaveBeenCalledWith(expect.stringMatching(/^idem:/), JSON.stringify({offer_id: 'o1', status: 'CONFIRMED'}), 'EX', expect.any(Number));
  });

  it('on a cache HIT returns the cached response and does NOT re-run the handler (acceptance e: single side-effect)', async () => {
    client.get.mockResolvedValue(JSON.stringify({offer_id: 'o1', status: 'CONFIRMED'}));
    const {handler, calls} = handlerReturning({offer_id: 'SHOULD_NOT_RUN'});
    const i = new IdempotencyInterceptor(redis);
    const result = await firstValueFrom(await i.intercept(ctxFor(reqWith('accept-offer-1')), handler));
    expect(result).toEqual({offer_id: 'o1', status: 'CONFIRMED'});
    expect(calls()).toBe(0);          // handler never invoked on replay
    expect(client.set).not.toHaveBeenCalled();
  });
});
