'use strict';

const campusTracks = {
  // WGS84 centers estimated from Esri World Imagery. Both long axes are nearly north–south.
  east: { name: '东操场', center: [30.884062, 121.896881] },
  west: { name: '西操场', center: [30.882492, 121.889223] }
};

function campusTrackCoordinates(center, lane, bearing, clockwise) {
  const radius = 36.5 + 1.22 * (lane - 1) + (lane === 1 ? 0.30 : 0.20);
  const straight = 84.39;
  const half = straight / 2;
  const angle = bearing * Math.PI / 180;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const metersPerDegree = 6371000 * Math.PI / 180;
  const metersPerLongitude = metersPerDegree * Math.cos(center[0] * Math.PI / 180);
  const points = [];

  function add(along, across) {
    const north = along * cos - across * sin;
    const east = along * sin + across * cos;
    points.push([center[0] + north / metersPerDegree, center[1] + east / metersPerLongitude]);
  }

  for (let step = 0; step < 12; step++) add(-half + straight * step / 12, radius);
  for (let step = 0; step < 72; step++) {
    const arc = Math.PI * step / 72;
    add(half + radius * Math.sin(arc), radius * Math.cos(arc));
  }
  for (let step = 0; step < 12; step++) add(half - straight * step / 12, -radius);
  for (let step = 0; step < 72; step++) {
    const arc = Math.PI * step / 72;
    add(-half - radius * Math.sin(arc), -radius * Math.cos(arc));
  }
  points.push(points[0]);
  return clockwise ? points.reverse() : points;
}
