'use strict';
/**
 * Amsterdamse buurten met een ongeveer-middelpunt (afgerond, geen adressen).
 * Alleen bedoeld om grof de afstand tussen twee mensen te schatten.
 */
const NEIGHBORHOODS = [
  { key: 'centrum', name: 'Centrum', lat: 52.3730, lng: 4.8930 },
  { key: 'jordaan', name: 'Jordaan', lat: 52.3745, lng: 4.8800 },
  { key: 'de-pijp', name: 'De Pijp', lat: 52.3547, lng: 4.8940 },
  { key: 'oud-zuid', name: 'Oud-Zuid', lat: 52.3530, lng: 4.8700 },
  { key: 'oost', name: 'Oost', lat: 52.3600, lng: 4.9250 },
  { key: 'indische-buurt', name: 'Indische Buurt', lat: 52.3640, lng: 4.9440 },
  { key: 'noord', name: 'Noord', lat: 52.3910, lng: 4.9300 },
  { key: 'nieuw-west', name: 'Nieuw-West', lat: 52.3660, lng: 4.8200 },
  { key: 'west', name: 'West', lat: 52.3770, lng: 4.8600 },
  { key: 'zuidoost', name: 'Zuidoost', lat: 52.3150, lng: 4.9740 },
  { key: 'zuid', name: 'Zuid / Buitenveldert', lat: 52.3300, lng: 4.8800 },
  { key: 'ijburg', name: 'IJburg', lat: 52.3550, lng: 5.0100 },
];
const BY_KEY = new Map(NEIGHBORHOODS.map((n) => [n.key, n]));

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function distanceKm(keyA, keyB) {
  const a = BY_KEY.get(keyA);
  const b = BY_KEY.get(keyB);
  if (!a || !b) return null;
  return haversineKm(a.lat, a.lng, b.lat, b.lng);
}

module.exports = { NEIGHBORHOODS, BY_KEY, haversineKm, distanceKm };
