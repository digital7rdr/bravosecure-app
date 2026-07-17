/**
 * Unit tests for userService.uploadAvatar — the Supabase Storage avatar upload
 * used by the shared useAvatarPicker hook (individual / CPO / service-provider).
 */

// Decode is irrelevant to the assertions; return a stable buffer.
jest.mock('base64-arraybuffer', () => ({
  decode: () => new Uint8Array([1, 2, 3]).buffer,
}));

// Avoid pulling the real constants module (it transitively loads an untransformed
// Expo ESM env shim under jest).
jest.mock('@utils/constants', () => ({SUPABASE_URL: 'http://test', SUPABASE_ANON_KEY: 'anon'}));

import {userService, supabase} from '@/services/supabase';

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();

describe('userService.uploadAvatar', () => {
  beforeEach(() => {
    mockUpload.mockReset().mockResolvedValue({error: null});
    mockGetPublicUrl.mockReset().mockReturnValue({
      data: {publicUrl: 'https://cdn.test/storage/v1/object/public/avatars/u1/avatar.jpg'},
    });
    jest
      .spyOn(supabase.storage, 'from')
      .mockReturnValue({upload: mockUpload, getPublicUrl: mockGetPublicUrl} as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('uploads to the per-user path and returns a cache-busted public URL', async () => {
    const url = await userService.uploadAvatar('u1', 'AAAA', 'image/jpeg');

    expect(supabase.storage.from).toHaveBeenCalledWith('avatars');
    expect(mockUpload).toHaveBeenCalledWith(
      'u1/avatar.jpg',
      expect.anything(),
      {contentType: 'image/jpeg', upsert: true},
    );
    expect(url).toMatch(
      /^https:\/\/cdn\.test\/storage\/v1\/object\/public\/avatars\/u1\/avatar\.jpg\?v=\d+$/,
    );
  });

  it('maps mime type to the right extension', async () => {
    await userService.uploadAvatar('u1', 'AAAA', 'image/png');
    expect(mockUpload).toHaveBeenCalledWith('u1/avatar.png', expect.anything(), expect.anything());

    await userService.uploadAvatar('u1', 'AAAA', 'image/webp');
    expect(mockUpload).toHaveBeenCalledWith('u1/avatar.webp', expect.anything(), expect.anything());
  });

  it('throws when the upload fails', async () => {
    mockUpload.mockResolvedValueOnce({error: new Error('storage_full')});
    await expect(userService.uploadAvatar('u1', 'AAAA', 'image/jpeg')).rejects.toThrow('storage_full');
  });
});
