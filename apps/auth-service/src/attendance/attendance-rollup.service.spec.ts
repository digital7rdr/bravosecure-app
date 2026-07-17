import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {AttendanceRollupService} from './attendance-rollup.service';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';

const mockDb = {q: jest.fn()};
const redisClient = {set: jest.fn(), del: jest.fn()};
const mockRedis = {client: redisClient};
const mockConfig = {get: jest.fn()};

describe('AttendanceRollupService', () => {
  let svc: AttendanceRollupService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockConfig.get.mockReturnValue(true); // flag on
    redisClient.del.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceRollupService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService, useValue: mockRedis},
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    svc = module.get(AttendanceRollupService);
  });

  it('marks absent under the lock via an idempotent NOT EXISTS insert', async () => {
    redisClient.set.mockResolvedValueOnce('OK');
    mockDb.q.mockResolvedValueOnce([{id: 's1'}, {id: 's2'}]);
    const out = await svc.sweepOnce();
    expect(out).toEqual({marked: 2, skipped_lock: false, skipped_flag: false});
    expect(String(mockDb.q.mock.calls[0][0])).toMatch(/NOT EXISTS/);
    expect(String(mockDb.q.mock.calls[0][0])).toMatch(/'absent'/);
    expect(redisClient.del).toHaveBeenCalled(); // lock released
  });

  it('skips when another pod holds the lock', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    const out = await svc.sweepOnce();
    expect(out.skipped_lock).toBe(true);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('no-ops when the flag is off (never touches Redis)', async () => {
    mockConfig.get.mockReturnValue(false);
    const out = await svc.sweepOnce();
    expect(out.skipped_flag).toBe(true);
    expect(redisClient.set).not.toHaveBeenCalled();
  });
});
