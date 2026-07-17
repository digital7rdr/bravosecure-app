import {Test} from '@nestjs/testing';
import {UsersService} from './users.service';
import {DatabaseService} from '../database/database.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};

describe('UsersService.lookupByPhones', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        {provide: DatabaseService, useValue: mockDb},
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('returns mapped rows for matching phones, excluding the caller', async () => {
    mockDb.q.mockResolvedValueOnce([
      {id: 'u-bob',   phone_e164: '+14155551000', display_name: 'Bob',   avatar_url: null},
      {id: 'u-carol', phone_e164: '+14155552000', display_name: 'Carol', avatar_url: 'https://cdn.example/c.png'},
    ]);

    const res = await service.lookupByPhones(
      ['+14155551000', '+14155552000', '+14155559999'],
      'u-alice',
    );

    expect(res).toEqual([
      {phone: '+14155551000', userId: 'u-bob',   displayName: 'Bob',   avatarUrl: null},
      {phone: '+14155552000', userId: 'u-carol', displayName: 'Carol', avatarUrl: 'https://cdn.example/c.png'},
    ]);

    const [sql, params] = mockDb.q.mock.calls[0];
    expect(params[0]).toEqual(['+14155551000', '+14155552000', '+14155559999']);
    expect(params[1]).toBe('u-alice');
    // The query must filter blocks in BOTH directions so a block hides
    // both parties from each other's directory. Either alias prefix is
    // acceptable — we only care that both orderings are present.
    expect(sql).toMatch(/blocker_user_id\s*=\s*\$2\s+AND\s+b?\.?blocked_user_id\s*=\s*u\.id/);
    expect(sql).toMatch(/blocker_user_id\s*=\s*u\.id\s+AND\s+b?\.?blocked_user_id\s*=\s*\$2/);
  });

  it('deduplicates phones before querying', async () => {
    mockDb.q.mockResolvedValueOnce([]);
    await service.lookupByPhones(['+11111111111', '+11111111111', '+12222222222'], 'caller');
    const [, params] = mockDb.q.mock.calls[0];
    expect(params[0]).toEqual(['+11111111111', '+12222222222']);
  });

  it('returns [] without hitting the DB when given an empty list', async () => {
    const res = await service.lookupByPhones([], 'caller');
    expect(res).toEqual([]);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('returns [] when DB has no matches', async () => {
    mockDb.q.mockResolvedValueOnce([]);
    const res = await service.lookupByPhones(['+19999999999'], 'caller');
    expect(res).toEqual([]);
  });
});

describe('UsersService.updatePreferences — Step 25', () => {
  let service: UsersService;
  const meRow = {
    id: 'u1', display_name: 'A', email: 'a@x.com', phone_e164: null, bio: null, avatar_url: null,
    last_seen_visible: true, read_receipts_enabled: true,
    language: 'ar', currency: 'AED', notif_prefs: {trip: true, marketing: false, safety: true},
    location_scope: 'while_on_duty', app_lock: false,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.qOne.mockResolvedValue(meRow); // getMe read after the update
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, {provide: DatabaseService, useValue: mockDb}],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('forces notif_prefs.safety = true even when the client tries to disable it', async () => {
    await service.updatePreferences('u1', {notifPrefs: {safety: false, marketing: false}});
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    expect(updateCall?.[0]).toMatch(/notif_prefs = \$\d+::jsonb/);
    const jsonParam = (updateCall?.[1] as unknown[]).find(p => typeof p === 'string' && (p as string).includes('safety'));
    expect(JSON.parse(jsonParam as string)).toEqual({safety: true, marketing: false});
  });

  it('drops non-boolean notif_prefs values (keeps the Record<string,boolean> contract)', async () => {
    await service.updatePreferences('u1', {
      notifPrefs: {trip: true, marketing: 'yes' as never, junk: 5 as never},
    });
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    const jsonParam = (updateCall?.[1] as unknown[]).find(p => typeof p === 'string' && (p as string).includes('safety'));
    expect(JSON.parse(jsonParam as string)).toEqual({trip: true, safety: true});
  });

  it('persists language/currency/location_scope/app_lock and re-forces safety on read', async () => {
    const me = await service.updatePreferences('u1', {language: 'ar', currency: 'AED', appLock: true});
    expect(me.notifPrefs.safety).toBe(true);
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    expect(updateCall?.[0]).toMatch(/language = \$1/);
  });

  it('no-ops the UPDATE when nothing is supplied (still returns Me)', async () => {
    const me = await service.updatePreferences('u1', {});
    expect(mockDb.q).not.toHaveBeenCalled();
    expect(me.id).toBe('u1');
  });
});
