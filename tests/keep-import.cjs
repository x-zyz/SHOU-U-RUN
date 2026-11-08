'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const KeepRunImport = require('../app/src/main/assets/keep-import.js');

const base = (points, extra = {}) => ({
  source: 'keep',
  activityId: 'fixture',
  dataType: 'outdoorRunning',
  startTime: 1767225600000,
  endTime: 1767225660000,
  distanceM: 150,
  durationS: 60,
  timezone: 'Asia/Shanghai',
  points,
  ...extra
});

const at = (seconds, speed = 2.5, extra = {}) => ({
  timestamp: seconds * 10,
  speed: speed * 3.6,
  currentTotalDistance: seconds * speed,
  accuracyRadius: 0,
  isPause: false,
  ...extra
});

test('converts Keep km/h speed into one 5-second window per interval', () => {
  const points = Array.from({length: 13}, (_, i) => at(i * 5));
  const parsed = KeepRunImport.parse(base(points));
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].length, 1);
  assert.equal(parsed.runs[0][0].length, 12);
  assert.equal(parsed.summary.windowCount, 12);
  assert.equal(parsed.summary.validSeconds, 60);
  assert.ok(parsed.runs[0][0].every(speed => Math.abs(speed - 2.5) < 0.001));
  assert.equal(parsed.reason, 'ok');
  assert.equal(parsed.message, null);
});

test('anchors relative decisecond timestamps to startTime', () => {
  const parsed = KeepRunImport.parse(base([at(0), at(5)]));
  assert.equal(parsed.summary.timeOrigin, 'relative');
  assert.equal(parsed.summary.windowCount, 1);
});

test('uses unixTimestamp as absolute time and prefers it over relative timestamp', () => {
  const points = [0, 5, 10].map((seconds, i) => ({
    ...at(seconds, 2.5),
    timestamp: i,
    unixTimestamp: 1767225600000 + seconds * 1000
  }));
  const parsed = KeepRunImport.parse(base(points));
  assert.equal(parsed.summary.timeOrigin, 'absolute');
  assert.equal(parsed.summary.windowCount, 2);
});

test('does not synthesize a timeline from a declared sample interval', () => {
  const points = Array.from({length: 6}, () => ({speed: 9, currentTotalDistance: 0}));
  const parsed = KeepRunImport.parse(base(points, {sampleIntervalMs: 5000}));
  assert.equal(parsed.runs.length, 0);
  assert.equal(parsed.summary.windowCount, 0);
  assert.equal(parsed.summary.timeOrigin, 'missing');
  assert.match(parsed.message, /可展示汇总，样本不足以拟合/);
});

test('returns summary-only when only distance and duration exist', () => {
  const parsed = KeepRunImport.parse(base([], {distanceM: 5000, durationS: 1800}));
  assert.equal(parsed.runs.length, 0);
  assert.equal(parsed.reason, 'summary_only');
  assert.match(parsed.message, /可展示汇总，样本不足以拟合/);
  assert.equal(parsed.summary.distanceM, 5000);
  assert.equal(parsed.summary.durationS, 1800);
});

test('splits on pause without bridging the paused interval', () => {
  const points = Array.from({length: 13}, (_, i) => at(i * 5, 2.5, {isPause: i === 4}));
  const parsed = KeepRunImport.parse(base(points));
  assert.equal(parsed.summary.segmentCount, 2);
  assert.equal(parsed.summary.pauseCount, 2);
  assert.equal(parsed.summary.windowCount, 10);
});

test('splits on a gap larger than the adaptive Keep threshold', () => {
  const parsed = KeepRunImport.parse(base([at(0), at(5), at(50), at(55)]));
  assert.equal(parsed.summary.gapCount, 1);
  assert.equal(parsed.summary.segmentCount, 2);
  assert.equal(parsed.summary.windowCount, 2);
});

test('derives speed from GPS coordinates when Keep speed is absent', () => {
  const points = Array.from({length: 13}, (_, i) => ({
    timestamp: i * 50,
    latitude: 30 + i * 0.0001124,
    longitude: 121,
    accuracyRadius: 0,
    isPause: false
  }));
  const parsed = KeepRunImport.parse(base(points));
  assert.equal(parsed.summary.windowCount, 12);
  assert.ok(parsed.runs[0][0].every(speed => Math.abs(speed - 2.5) < 0.03));
});

test('rejects points outside the running speed range and over 35m accuracy', () => {
  const points = [
    at(0, 0.5),
    at(5, 2.5, {accuracyRadius: 80}),
    at(10, 2.5, {accuracyRadius: 80})
  ];
  const parsed = KeepRunImport.parse(base(points));
  assert.ok(parsed.summary.invalidSpeedCount >= 1);
  assert.ok(parsed.summary.invalidAccuracyCount >= 1);
  assert.equal(parsed.summary.windowCount, 0);
});

test('insufficient windows returns a diagnostic instead of throwing', () => {
  const activity = base(Array.from({length: 6}, (_, i) => at(i * 5)));
  const result = KeepRunImport.fit(activity, () => { throw new Error('should not be called'); });
  assert.equal(result.parsed.summary.windowCount, 5);
  assert.equal(result.ok, false);
  assert.match(result.message, /有效窗口仅 5 个/);
  assert.equal(result.profile, undefined);
});

test('fits a 60-second Keep run and marks the profile source', () => {
  const RunPaceProfile = require('../app/src/main/assets/personal-pace.js');
  const points = Array.from({length: 13}, (_, i) => at(i * 5));
  const result = KeepRunImport.fit(base(points), RunPaceProfile.fit);
  assert.equal(result.ok, true);
  assert.equal(result.profile.source, 'keep');
  assert.equal(result.profile.runs, 1);
  assert.equal(result.profile.seconds, 60);
  assert.equal(result.profile.imports[0].source, 'keep');
  assert.equal(result.profile.imports[0].activityId, 'fixture');
  assert.equal(result.profile.imports[0].validSeconds, 60);
});

test('sanitized sample removes coordinates, Keep ID and absolute dates', () => {
  const originalStart = 1735689600000;
  const points = Array.from({length: 13}, (_, i) => at(i * 5, 2.5, {
    latitude: 31.2 + i * 0.0001,
    longitude: 121.4 + i * 0.0001,
    unixTimestamp: originalStart + i * 5000
  }));
  const sample = KeepRunImport.sanitize(base(points, {startTime: originalStart}));
  const text = JSON.stringify(sample);
  assert.equal(sample.sanitized, true);
  assert.equal(sample.source, 'keep');
  assert.equal(sample.points.length, 13);
  assert.ok(sample.points.every(point => point.latitude === undefined && point.longitude === undefined));
  assert.ok(!text.includes(String(originalStart)));
  assert.ok(!text.includes('fixture'));
  const replayed = KeepRunImport.parse(sample);
  assert.equal(replayed.summary.windowCount, 12);
  assert.equal(replayed.summary.validSeconds, 60);
});

test('report contains counts but no raw points or identifiers', () => {
  const RunPaceProfile = require('../app/src/main/assets/personal-pace.js');
  const points = Array.from({length: 13}, (_, i) => at(i * 5));
  const result = KeepRunImport.fit(base(points), RunPaceProfile.fit);
  const report = KeepRunImport.report(result);
  const text = JSON.stringify(report);
  assert.equal(report.format, 'shou.keep-import.report.v1');
  assert.equal(report.summary.windowCount, 12);
  assert.equal(report.summary.validSeconds, 60);
  assert.equal(report.fit.ok, true);
  assert.ok(!text.includes('latitude'));
  assert.ok(!text.includes('longitude'));
  assert.ok(!text.includes('"points"'));
  assert.ok(!text.includes('fixture'));
  assert.ok(!text.includes('token'));
});

test('optionally replays a local sanitized Keep run', {skip: !process.env.SHOU_KEEP_FIXTURE}, () => {
  const profile = require('../app/src/main/assets/personal-pace.js');
  const fixture = JSON.parse(fs.readFileSync(path.resolve(process.env.SHOU_KEEP_FIXTURE), 'utf8'));
  assert.equal(fixture.sanitized, true);
  assert.equal(fixture.source, 'keep');
  assert.equal(fixture.dataType, 'outdoorRunning');
  assert.ok(fixture.points.every(point => point.latitude === undefined &&
    point.longitude === undefined && point.unixTimestamp === undefined));
  const result = KeepRunImport.fit(fixture, profile.fit);
  assert.equal(result.ok, true);
  assert.equal(result.profile.seconds, result.parsed.summary.windowCount * 5);
});

test('native JSON null fields stay missing and GPS can supply speed', () => {
  const points = Array.from({length: 13}, (_, i) => ({timestamp: i * 50, unixTimestamp: null,
    speed: null, currentTotalDistance: null, latitude: 30 + i * .0001124, longitude: 121, accuracyRadius: null}));
  const parsed = KeepRunImport.parse(base(points));
  assert.equal(parsed.summary.speed, false);
  assert.equal(parsed.summary.distance, false);
  assert.equal(parsed.summary.validSeconds, 60);
  assert.equal(KeepRunImport.parse(base([{...points[0], timestamp: null}])).summary.timeOrigin, 'missing');
});

test('fits multiple Keep records regardless of their source metadata', () => {
  const personal = require('../app/src/main/assets/personal-pace.js');
  const points = Array.from({length: 13}, (_, i) => at(i * 5));
  const result = KeepRunImport.fitHistory([base(points, {vendor: {genre: 'App'}}), base(points, {vendor: {genre: 'FileImport'}})], personal.fit);
  assert.equal(result.ok, true);
  assert.equal(result.profile.source, 'keep');
  assert.equal(result.profile.runs, 2);
  assert.equal(result.profile.seconds, 120);
  assert.equal(KeepRunImport.fitHistory([base([])], personal.fit).ok, false);
});
