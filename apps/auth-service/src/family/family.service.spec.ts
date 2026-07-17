import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {FamilyService}       from './family.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};

describe('FamilyService', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [FamilyService, {provide: DatabaseService, useValue: mockDb}],
    }).compile();
    svc = module.get(FamilyService);
  });

  describe('invite', () => {
    it('creates a pending invite for a registered phone', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000001'}) // phone → user
        .mockResolvedValueOnce({n: 0})        // active count
        .mockResolvedValueOnce(null)          // not in another family
        .mockResolvedValueOnce({id: 'fm-1'}); // insert
      const res = await svc.invite('u-holder', '+971500000001', 200);
      expect(res).toEqual({id: 'fm-1', status: 'pending'});
    });

    it('rejects inviting yourself', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'u-holder', phone_e164: '+971500000000'});
      await expect(svc.invite('u-holder', '+971500000000')).rejects.toThrow(BadRequestException);
    });

    it('rejects when the family is full (4 active)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)       // phone not registered (pending-by-phone)
        .mockResolvedValueOnce({n: 4});    // active count
      await expect(svc.invite('u-holder', '+971500000009')).rejects.toThrow(/family_full/);
    });

    it('rejects an invalid phone', async () => {
      await expect(svc.invite('u-holder', 'nope')).rejects.toThrow(/invalid_phone/);
    });
  });

  describe('accept', () => {
    it('binds the member and activates', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)            // not active elsewhere
        .mockResolvedValueOnce({id: 'fm-1'});   // update returns row
      await expect(svc.accept('u-member', 'fm-1')).resolves.toEqual({ok: true});
    });
    it('refuses if already in a family', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-other'});
      await expect(svc.accept('u-member', 'fm-1')).rejects.toThrow(/already_in_a_family/);
    });
  });

  describe('resolvePayer (billing hook)', () => {
    it('returns the holder for an active member', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1', holder_id: 'u-holder', spend_limit_credits: 500, spent_credits: 100});
      const res = await svc.resolvePayer('u-member');
      expect(res).toEqual({payerId: 'u-holder', familyRowId: 'fm-1', spendLimit: 500, spent: 100});
    });
    it('returns the user themselves when not a member (identity)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await svc.resolvePayer('u-stranger');
      expect(res).toEqual({payerId: 'u-stranger', familyRowId: null, spendLimit: null, spent: 0});
    });
  });
});
