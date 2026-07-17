/**
 * Rough country-name → lat/lng geotagger.
 *
 * The Guardian feed doesn't carry coordinates, only a `sectionName` and
 * free-text headline. To place a marker on the Intel map we scan the
 * headline for a country / region name and look up its capital. Coarse
 * but deterministic — good enough for a "where in the world" glance.
 *
 * When nothing matches we pick a pseudo-random position within the
 * MENA/Europe/Asia band so the map never looks half-empty.
 */

export interface GeoHit {
  lng:    number;
  lat:    number;
  label:  string;
}

const GEO: Array<{names: string[]; lng: number; lat: number; label: string}> = [
  // Core MENA / GCC
  {names: ['UAE', 'United Arab Emirates', 'Dubai', 'Abu Dhabi', 'DIFC'], lng: 55.27, lat: 25.20, label: 'UAE'},
  {names: ['Saudi', 'Riyadh', 'Jeddah'],     lng: 46.68, lat: 24.71, label: 'KSA'},
  {names: ['Qatar', 'Doha'],                 lng: 51.53, lat: 25.29, label: 'QATAR'},
  {names: ['Oman', 'Muscat'],                lng: 58.54, lat: 23.59, label: 'OMAN'},
  {names: ['Kuwait'],                        lng: 47.98, lat: 29.38, label: 'KUWAIT'},
  {names: ['Bahrain', 'Manama'],             lng: 50.59, lat: 26.23, label: 'BAHRAIN'},
  {names: ['Iraq', 'Baghdad'],               lng: 44.36, lat: 33.31, label: 'IRAQ'},
  {names: ['Iran', 'Tehran'],                lng: 51.39, lat: 35.69, label: 'IRAN'},
  {names: ['Israel', 'Tel Aviv', 'Jerusalem'], lng: 34.78, lat: 32.08, label: 'ISRAEL'},
  {names: ['Gaza', 'Palestine', 'West Bank'], lng: 34.47, lat: 31.50, label: 'GAZA'},
  {names: ['Lebanon', 'Beirut'],             lng: 35.50, lat: 33.89, label: 'LEBANON'},
  {names: ['Syria', 'Damascus'],             lng: 36.29, lat: 33.51, label: 'SYRIA'},
  {names: ['Jordan', 'Amman'],               lng: 35.93, lat: 31.95, label: 'JORDAN'},
  {names: ['Yemen', 'Sanaa'],                lng: 44.19, lat: 15.36, label: 'YEMEN'},
  {names: ['Egypt', 'Cairo'],                lng: 31.23, lat: 30.04, label: 'EGYPT'},
  {names: ['Turkey', 'Ankara', 'Istanbul'],  lng: 28.98, lat: 41.01, label: 'TURKEY'},

  // Europe
  {names: ['UK', 'Britain', 'United Kingdom', 'London', 'England'], lng: -0.13, lat: 51.51, label: 'UK'},
  {names: ['France', 'Paris'],               lng:  2.35, lat: 48.86, label: 'FRANCE'},
  {names: ['Germany', 'Berlin'],             lng: 13.41, lat: 52.52, label: 'GERMANY'},
  {names: ['Italy', 'Rome'],                 lng: 12.50, lat: 41.90, label: 'ITALY'},
  {names: ['Spain', 'Madrid'],               lng: -3.70, lat: 40.42, label: 'SPAIN'},
  {names: ['Russia', 'Moscow'],              lng: 37.62, lat: 55.76, label: 'RUSSIA'},
  {names: ['Ukraine', 'Kyiv', 'Kiev'],       lng: 30.52, lat: 50.45, label: 'UKRAINE'},

  // Asia-Pacific
  {names: ['China', 'Beijing', 'Shanghai'],  lng: 116.40, lat: 39.90, label: 'CHINA'},
  {names: ['Japan', 'Tokyo'],                lng: 139.69, lat: 35.69, label: 'JAPAN'},
  {names: ['Korea', 'Seoul'],                lng: 126.98, lat: 37.57, label: 'KOREA'},
  {names: ['India', 'Delhi', 'Mumbai'],      lng: 77.21, lat: 28.61, label: 'INDIA'},
  {names: ['Pakistan', 'Islamabad'],         lng: 73.05, lat: 33.68, label: 'PAKISTAN'},
  {names: ['Bangladesh', 'Dhaka'],           lng: 90.41, lat: 23.81, label: 'BANGLADESH'},
  {names: ['Afghanistan', 'Kabul'],          lng: 69.21, lat: 34.53, label: 'AFGHANISTAN'},
  {names: ['Singapore'],                     lng: 103.82, lat: 1.35, label: 'SINGAPORE'},
  {names: ['Hong Kong'],                     lng: 114.17, lat: 22.28, label: 'HK'},

  // Americas + Africa
  {names: ['US', 'USA', 'United States', 'Washington', 'New York'], lng: -74.00, lat: 40.71, label: 'USA'},
  {names: ['Canada', 'Toronto', 'Ottawa'],   lng: -79.38, lat: 43.65, label: 'CANADA'},
  {names: ['Mexico'],                        lng: -99.13, lat: 19.43, label: 'MEXICO'},
  {names: ['Brazil', 'São Paulo', 'Sao Paulo'], lng: -46.63, lat: -23.55, label: 'BRAZIL'},
  {names: ['Argentina', 'Buenos Aires'],     lng: -58.38, lat: -34.60, label: 'ARGENTINA'},
  {names: ['Nigeria', 'Lagos'],              lng:   3.38, lat:  6.52, label: 'NIGERIA'},
  {names: ['South Africa', 'Johannesburg', 'Cape Town'], lng: 28.05, lat: -26.20, label: 'SOUTH AFRICA'},
  {names: ['Kenya', 'Nairobi'],              lng: 36.82, lat: -1.29, label: 'KENYA'},
  {names: ['Australia', 'Sydney', 'Melbourne'], lng: 151.21, lat: -33.87, label: 'AUSTRALIA'},
];

/**
 * Find the first geo match inside `text`. Matches are case-insensitive
 * and use word boundaries so "Iraq" doesn't match "Iraqi" (that would
 * also be an Iraq hit, which is fine — but also so "UK" doesn't match
 * "puking", which is not).
 */
export function geotag(text: string): GeoHit | null {
  const upper = text.toUpperCase();
  for (const row of GEO) {
    for (const name of row.names) {
      const re = new RegExp(`\\b${name.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(upper)) {
        return {lng: row.lng, lat: row.lat, label: row.label};
      }
    }
  }
  return null;
}

/**
 * Severity heuristic — stamps headlines with a colour tier based on
 * keyword presence. Mirrors the hand-tuned palette in the original
 * mock data. Deterministic so the same article always gets the same
 * marker colour across app sessions.
 */
export function severityFor(headline: string, sectionId: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  const t = headline.toLowerCase();
  if (/\b(killed|attack|strike|bomb|ballistic|shooting|massacre|crisis|emergency)\b/.test(t)) return 'CRITICAL';
  if (/\b(protest|riot|threat|sanction|war|violence|clash|unrest)\b/.test(t))                return 'HIGH';
  if (sectionId === 'world' || sectionId === 'politics')                                     return 'MEDIUM';
  return 'LOW';
}

/** Map a Guardian `sectionId` to the visual tag shown on the Wire tab. */
export function sectionToTag(sectionId: string): string {
  switch (sectionId) {
    case 'world':        return 'POLITICAL';
    case 'politics':     return 'POLITICAL';
    case 'business':     return 'FINANCE';
    case 'money':        return 'FINANCE';
    case 'environment':  return 'CLIMATE';
    case 'technology':   return 'TECH';
    case 'sport':        return 'SPORT';
    case 'society':      return 'SOCIETY';
    default:             return 'GENERAL';
  }
}
