import {
  regionFromCountry, isSupportedRegion, regionName, regionFromBBox, detectRegion,
  SUPPORTED_REGION_CODES, REGION_NA,
} from '../regions';

describe('region helpers', () => {
  it('maps ISO country → region (case-insensitive)', () => {
    expect(regionFromCountry('AE')).toBe('AE');
    expect(regionFromCountry('ae')).toBe('AE');
    expect(regionFromCountry(' gb ')).toBe('GB');
    expect(regionFromCountry('US')).toBe(REGION_NA);
    expect(regionFromCountry(null)).toBe(REGION_NA);
    expect(regionFromCountry(undefined)).toBe(REGION_NA);
  });

  it('validates supported regions', () => {
    expect(isSupportedRegion('SA')).toBe(true);
    expect(isSupportedRegion('za')).toBe(true);
    expect(isSupportedRegion('XX')).toBe(false);
    expect(isSupportedRegion(null)).toBe(false);
    expect(SUPPORTED_REGION_CODES).toEqual(['AE', 'SA', 'BD', 'GB', 'ZA']);
  });

  it('names regions', () => {
    expect(regionName('BD')).toBe('Bangladesh');
    expect(regionName('GB')).toBe('United Kingdom');
    expect(regionName(null)).toBe('—');
  });
});

describe('regionFromBBox (offline fallback)', () => {
  const cases: Array<[string, number, number, string]> = [
    ['Dubai → AE (not the overlapping SA box)', 25.2048, 55.2708, 'AE'],
    ['Riyadh → SA', 24.7136, 46.6753, 'SA'],
    ['Jeddah → SA', 21.4858, 39.1925, 'SA'],
    ['Dhaka → BD', 23.8103, 90.4125, 'BD'],
    ['London → GB', 51.5074, -0.1278, 'GB'],
    ['Johannesburg → ZA', -26.2041, 28.0473, 'ZA'],
    ['New York → N/A (outside coverage)', 40.7128, -74.006, REGION_NA],
  ];
  it.each(cases)('%s', (_label, lat, lng, expected) => {
    expect(regionFromBBox(lat, lng)).toBe(expected);
  });
});

describe('detectRegion', () => {
  it('prefers the reverse-geocoded country when present', () => {
    // A Dubai fix whose country resolves to SA (e.g. near the border) trusts the geocode.
    expect(detectRegion('SA', 25.2048, 55.2708)).toEqual({region: 'SA', country: 'SA', source: 'geocode'});
    expect(detectRegion('gb', 0, 0)).toEqual({region: 'GB', country: 'GB', source: 'geocode'});
  });

  it('falls back to bounding boxes when the country is unknown', () => {
    expect(detectRegion(null, 25.2048, 55.2708)).toEqual({region: 'AE', country: null, source: 'bbox'});
    expect(detectRegion(undefined, 40.7128, -74.006)).toEqual({region: REGION_NA, country: null, source: 'bbox'});
  });
});
