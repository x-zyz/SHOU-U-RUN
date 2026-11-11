'use strict';

const campusTracks = {
  // WGS84 centers estimated from Esri World Imagery. Both long axes are nearly north–south.
  east: { name: '东操场', center: [30.884062, 121.896881], randomLaneLimit: 8 },
  west: { name: '西操场', center: [30.882492, 121.889223], randomLaneLimit: 4 }
};

function campusTrackLanes(laps, singleLane, laneLimit) {
  if (laps === 1) return [singleLane];
  const lanes = [1 + Math.floor(Math.random() * laneLimit)];
  while (lanes.length < laps) {
    const lane = lanes.at(-1);
    const adjacent = [lane - 1, lane + 1].filter(next => next >= 1 && next <= laneLimit);
    lanes.push(adjacent[Math.floor(Math.random() * adjacent.length)]);
  }
  return lanes;
}

function campusTrackCoordinates(center, lanes, bearing, clockwise) {
  const radius = lane => 36.5 + 1.22 * (lane - 1) + (lane === 1 ? 0.30 : 0.20);
  const straight = 84.39;
  const half = straight / 2;
  const angle = bearing * Math.PI / 180;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const metersPerDegree = 6371000 * Math.PI / 180;
  const metersPerLongitude = metersPerDegree * Math.cos(center[0] * Math.PI / 180);
  const points = [];

  function add(along, across) {
    if (clockwise) along = -along;
    const north = along * cos - across * sin;
    const east = along * sin + across * cos;
    points.push([center[0] + north / metersPerDegree, center[1] + east / metersPerLongitude]);
  }

  let previousRadius = radius(lanes[0]);
  for (const lane of lanes) {
    const currentRadius = radius(lane);
    for (let step = 0; step < 12; step++) {
      const progress = step / 12;
      // Ease across lanes on the first straight, with room before the bend.
      const t = Math.min(1, Math.max(0, (progress - 0.25) * 2));
      const eased = t * t * (3 - 2 * t);
      add(-half + straight * progress, previousRadius + (currentRadius - previousRadius) * eased);
    }
    for (let step = 0; step < 72; step++) {
      const arc = Math.PI * step / 72;
      add(half + currentRadius * Math.sin(arc), currentRadius * Math.cos(arc));
    }
    for (let step = 0; step < 12; step++) add(half - straight * step / 12, -currentRadius);
    for (let step = 0; step < 72; step++) {
      const arc = Math.PI * step / 72;
      add(-half - currentRadius * Math.sin(arc), -currentRadius * Math.cos(arc));
    }
    previousRadius = currentRadius;
  }
  add(-half, previousRadius);
  return points;
}

function campusTrackTail(center, lane, bearing, clockwise, meters) {
  const lap = campusTrackCoordinates(center, [lane], bearing, clockwise);
  const lengths = RunCore.lengths(lap);
  const index = lengths.findIndex(distance => distance >= meters);
  const from = lap[index - 1];
  const to = lap[index];
  const fraction = (meters - lengths[index - 1]) / (lengths[index] - lengths[index - 1]);
  const finish = from.map((value, axis) => value + fraction * (to[axis] - value));
  return [...lap.slice(1, index), finish];
}
