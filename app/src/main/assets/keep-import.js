(function (root) {
'use strict';

const WINDOW_SECONDS = 5;
const MAX_WINDOWS = 2160;
const MS_MIN = Date.UTC(2001, 0, 1);
const MS_MAX = Date.UTC(2100, 0, 1);
const DECISECOND_ABSOLUTE_MIN = MS_MIN / 100;
const EARTH_RADIUS_M = 6371000;

const numberOrNull = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};
const epochOrNull = value => {
  if (typeof value === 'string' && value.trim()) value = Date.parse(value);
  const number = numberOrNull(value);
  return number !== null && number >= MS_MIN && number < MS_MAX ? number : null;
};
const isPaused = point => point.isPause === true || point.pause === true;
const coordinates = point => {
  const lat = numberOrNull(point.latitude), lon = numberOrNull(point.longitude);
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0) ? [lat, lon] : null;
};
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const left = Math.floor(position);
  return sorted[left] + (sorted[Math.ceil(position)] - sorted[left]) * (position - left);
};
const haversine = (a, b) => {
  const lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180;
  const dLat = lat2 - lat1, dLon = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

function pointTime(point, startTime) {
  const unix = numberOrNull(point.unixTimestamp);
  if (unix !== null && unix >= MS_MIN && unix < MS_MAX) return {timeMs: unix, origin: 'absolute'};
  const timestamp = numberOrNull(point.timestamp);
  if (timestamp === null) return {timeMs: null, origin: 'missing'};
  const absolute = timestamp * 100;
  if (timestamp >= DECISECOND_ABSOLUTE_MIN && absolute < MS_MAX) return {timeMs: absolute, origin: 'absolute'};
  return {timeMs: startTime === null ? null : startTime + absolute, origin: 'relative'};
}

function normalize(activity) {
  const source = typeof activity?.source === 'string' && activity.source ? activity.source : 'keep';
  const points = Array.isArray(activity?.points) ? activity.points : [];
  const startTime = epochOrNull(activity?.startTime);
  const endTime = epochOrNull(activity?.endTime);
  const distanceM = numberOrNull(activity?.distanceM ?? activity?.distance);
  const durationS = numberOrNull(activity?.durationS ?? activity?.duration) ??
    (startTime !== null && endTime !== null ? (endTime - startTime) / 1000 : null);
  const activityInfo = {
    id: String(activity?.activityId ?? activity?.id ?? ''),
    dataType: typeof activity?.dataType === 'string' ? activity.dataType : '',
    startTime,
    endTime,
    distanceM,
    durationS,
    timezone: typeof activity?.timezone === 'string' ? activity.timezone : ''
  };

  const normalized = points.map(point => {
    const time = pointTime(point || {}, startTime);
    const rawSpeed = numberOrNull(point?.speed);
    const accuracy = numberOrNull(point?.accuracyRadius) ?? numberOrNull(point?.accuracyM) ??
      numberOrNull(point?.accuracy);
    return {
      timeMs: time.timeMs,
      timeOrigin: time.origin,
      measuredSpeedMps: rawSpeed !== null && rawSpeed >= 0 ? rawSpeed / 3.6 : null,
      distanceM: numberOrNull(point?.currentTotalDistance) ?? numberOrNull(point?.distanceM) ??
        numberOrNull(point?.distance),
      coordinates: coordinates(point || {}),
      accuracyM: accuracy !== null && accuracy > 0 ? accuracy : null,
      paused: isPaused(point || {})
    };
  });

  const timeOrigins = [...new Set(normalized.filter(point => point.timeMs !== null).map(point => point.timeOrigin))];
  const timing = timeOrigins.length === 0 ? 'missing' :
    timeOrigins.length === 1 ? timeOrigins[0] : 'mixed';
  const positiveGaps = [];
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i - 1].timeMs !== null && normalized[i].timeMs !== null) {
      const gap = (normalized[i].timeMs - normalized[i - 1].timeMs) / 1000;
      if (gap > 0) positiveGaps.push(gap);
    }
  }
  const medianGap = quantile(positiveGaps, .5);
  const gapLimitSeconds = Math.max(3, Math.min(15, (medianGap ?? 3) * 2.5));
  const fields = {
    timestamp: points.some(point => numberOrNull(point?.timestamp) !== null),
    unixTimestamp: points.some(point => numberOrNull(point?.unixTimestamp) !== null),
    speed: points.some(point => numberOrNull(point?.speed) !== null),
    distance: points.some(point => numberOrNull(point?.currentTotalDistance) !== null ||
      numberOrNull(point?.distanceM) !== null || numberOrNull(point?.distance) !== null),
    coordinates: normalized.some(point => point.coordinates !== null),
    accuracy: normalized.some(point => point.accuracyM !== null),
    pause: normalized.some(point => point.paused)
  };
  return {
    source,
    activity: activityInfo,
    points: normalized,
    timing,
    gapLimitSeconds,
    fields,
    summary: {
      source,
      activityId: activityInfo.id,
      dataType: activityInfo.dataType,
      startTime,
      distanceM,
      durationS,
      pointCount: points.length,
      usablePointCount: normalized.filter(point => point.timeMs !== null).length,
      timeOrigin: timing,
      gapLimitSeconds,
      ...fields
    }
  };
}

function intervalSpeed(a, b, dt) {
  const measured = [a.measuredSpeedMps, b.measuredSpeedMps].filter(value => value !== null);
  if (measured.length) return measured.reduce((sum, value) => sum + value, 0) / measured.length;
  if (a.distanceM !== null && b.distanceM !== null) {
    const distance = b.distanceM - a.distanceM;
    if (distance >= 0) return distance / dt;
  }
  if (a.coordinates && b.coordinates) return haversine(a.coordinates, b.coordinates) / dt;
  return null;
}

function buildWindows(points, gapLimitSeconds) {
  const segments = [];
  let segment = [];
  let bucketSeconds = 0, bucketDistance = 0;
  let windowCount = 0, gapCount = 0, pauseCount = 0;
  let invalidSpeedCount = 0, invalidAccuracyCount = 0;
  let full = false;

  const split = () => {
    if (segment.length) segments.push(segment);
    segment = [];
    bucketSeconds = 0;
    bucketDistance = 0;
  };

  for (let i = 0; i < points.length - 1 && !full; i++) {
    const a = points[i], b = points[i + 1];
    if (a.paused || b.paused) {
      pauseCount += (a.paused ? 1 : 0) + (b.paused ? 1 : 0);
      split();
      continue;
    }
    if (a.timeMs === null || b.timeMs === null) {
      split();
      continue;
    }
    const dt = (b.timeMs - a.timeMs) / 1000;
    if (!(dt > 0)) {
      split();
      continue;
    }
    if (dt > gapLimitSeconds) {
      gapCount++;
      split();
      continue;
    }
    const badSpeed = [a, b].some(point => point.measuredSpeedMps !== null &&
      (point.measuredSpeedMps < 1 || point.measuredSpeedMps > 6.5));
    if (badSpeed) {
      invalidSpeedCount++;
      split();
      continue;
    }
    const badAccuracy = [a, b].some(point => point.accuracyM !== null && point.accuracyM > 35);
    if (badAccuracy) {
      invalidAccuracyCount++;
      split();
      continue;
    }
    const speed = intervalSpeed(a, b, dt);
    if (speed === null || !Number.isFinite(speed) || speed < 1 || speed > 6.5) {
      invalidSpeedCount++;
      split();
      continue;
    }

    let remaining = dt;
    while (remaining > 1e-9) {
      const used = Math.min(remaining, WINDOW_SECONDS - bucketSeconds);
      bucketSeconds += used;
      bucketDistance += used * speed;
      remaining -= used;
      if (bucketSeconds >= WINDOW_SECONDS - 1e-9) {
        segment.push(Math.round(bucketDistance / WINDOW_SECONDS * 1000) / 1000);
        windowCount++;
        bucketSeconds = 0;
        bucketDistance = 0;
        if (windowCount >= MAX_WINDOWS) {
          full = true;
          break;
        }
      }
    }
  }
  split();
  return {segments, segmentCount: segments.length, windowCount, gapCount, pauseCount, invalidSpeedCount, invalidAccuracyCount};
}

function parse(activity) {
  const normalized = normalize(activity);
  const windows = buildWindows(normalized.points, normalized.gapLimitSeconds);
  const {segments, ...windowCounts} = windows;
  const summary = {
    ...normalized.summary,
    ...windowCounts,
    validSeconds: windows.windowCount * WINDOW_SECONDS
  };
  let reason = 'ok', message = null;
  if (normalized.points.length === 0) {
    reason = 'summary_only';
    message = '可展示汇总，样本不足以拟合。';
  } else if (normalized.summary.usablePointCount === 0) {
    reason = 'no_timing';
    message = '可展示汇总，样本不足以拟合（缺少逐点时间）。';
  } else if (windows.windowCount === 0) {
    reason = 'summary_only';
    message = '可展示汇总，样本不足以拟合。';
  } else if (windows.windowCount < 6) {
    reason = 'insufficient_windows';
    message = '有效窗口仅 ' + windows.windowCount + ' 个（不足 30 秒），样本不足以拟合。';
  }
  return {
    source: normalized.source,
    activity: normalized.activity,
    runs: windows.segments.length ? [windows.segments] : [],
    summary,
    reason,
    message
  };
}

function fit(activity, fitFn) {
  const parsed = parse(activity);
  if (parsed.runs.length === 0 || parsed.summary.windowCount < 6) {
    return {ok: false, parsed, message: parsed.message};
  }
  try {
    const profile = fitFn(parsed.runs);
    profile.source = 'keep';
    profile.imports = [{
      source: 'keep',
      activityId: parsed.activity.id,
      dataType: parsed.activity.dataType,
      startTime: parsed.activity.startTime,
      windowCount: parsed.summary.windowCount,
      validSeconds: parsed.summary.validSeconds
    }];
    return {
      ok: true,
      parsed,
      profile,
      message: 'Keep 导入成功：' + parsed.summary.windowCount + ' 个有效窗口 / ' +
        parsed.summary.validSeconds + ' 秒；个人模型拟合成功。'
    };
  } catch (error) {
    return {ok: false, parsed, message: error?.message || '个人模型拟合失败。'};
  }
}

function fitHistory(activities, fitFn) {
  const runs = [];
  let remaining = MAX_WINDOWS;
  for (const activity of activities) {
    const parsed = parse(activity);
    const segments = [];
    let count = 0;
    for (const segment of parsed.runs[0] || []) {
      const kept = segment.slice(0, remaining - count);
      if (kept.length) segments.push(kept);
      count += kept.length;
      if (count >= remaining) break;
    }
    if (count < 3) continue;
    runs.push(segments);
    remaining -= count;
    if (remaining < 3) break;
  }
  try {
    const profile = fitFn(runs);
    profile.source = 'keep';
    return {ok: true, profile,
      message: '已用 ' + profile.runs + ' 次 Keep 跑步的 ' + profile.seconds + ' 秒有效速度拟合个人模型。'};
  } catch (error) {
    return {ok: false, message: error.message};
  }
}

const SANITIZED_START = Date.UTC(2026, 0, 1);
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function representativeSpeed(points, index) {
  const point = points[index];
  if (point.measuredSpeedMps !== null) return point.measuredSpeedMps;
  for (const [a, b] of [[point, points[index + 1]], [points[index - 1], point]]) {
    if (!a || !b || a.timeMs === null || b.timeMs === null || a.paused || b.paused) continue;
    const dt = (b.timeMs - a.timeMs) / 1000;
    const speed = dt > 0 ? intervalSpeed(a, b, dt) : null;
    if (speed !== null && speed >= 1 && speed <= 6.5) return speed;
  }
  return null;
}

function sanitize(activity) {
  const normalized = normalize(activity);
  const firstTime = normalized.points.find(point => point.timeMs !== null)?.timeMs ?? null;
  const firstDistance = normalized.points.find(point => point.distanceM !== null)?.distanceM ?? null;
  const points = normalized.points.map((point, index) => {
    const speed = representativeSpeed(normalized.points, index);
    return {
      timestamp: point.timeMs !== null && firstTime !== null ? Math.round((point.timeMs - firstTime) / 100) : null,
      speed: speed === null ? null : round(speed * 3.6),
      currentTotalDistance: point.distanceM !== null && firstDistance !== null
        ? round(point.distanceM - firstDistance) : null,
      accuracyRadius: point.accuracyM === null ? null : round(point.accuracyM),
      isPause: point.paused
    };
  });
  const duration = normalized.activity.durationS ?? 0;
  return {
    format: 'shou.keep-import.sample.v1',
    sanitized: true,
    source: 'keep',
    note: 'Keep 户外跑步；已移除坐标、账号、活动 ID 和原始绝对日期，保留相对时间、速度、累计距离与暂停标记。',
    dataType: normalized.activity.dataType,
    startTime: SANITIZED_START,
    endTime: SANITIZED_START + Math.max(0, duration) * 1000,
    durationS: normalized.activity.durationS,
    distanceM: normalized.activity.distanceM,
    timezone: '',
    fields: normalized.fields,
    timing: normalized.timing,
    points
  };
}

function report(result) {
  const parsed = result?.parsed;
  const summary = parsed?.summary ?? {};
  const profile = result?.profile;
  return {
    format: 'shou.keep-import.report.v1',
    at: new Date().toISOString(),
    source: parsed?.source ?? 'keep',
    dataType: parsed?.activity?.dataType ?? '',
    startDate: parsed?.activity?.startTime ? new Date(parsed.activity.startTime).toISOString().slice(0, 10) : null,
    summary: {
      pointCount: summary.pointCount ?? 0,
      usablePointCount: summary.usablePointCount ?? 0,
      windowCount: summary.windowCount ?? 0,
      validSeconds: summary.validSeconds ?? 0,
      segmentCount: summary.segmentCount ?? 0,
      gapCount: summary.gapCount ?? 0,
      pauseCount: summary.pauseCount ?? 0,
      invalidSpeedCount: summary.invalidSpeedCount ?? 0,
      invalidAccuracyCount: summary.invalidAccuracyCount ?? 0,
      timeOrigin: summary.timeOrigin ?? 'missing',
      gapLimitSeconds: summary.gapLimitSeconds ?? null,
      distanceM: summary.distanceM ?? null,
      durationS: summary.durationS ?? null,
      fields: {
        timestamp: summary.timestamp === true,
        unixTimestamp: summary.unixTimestamp === true,
        speed: summary.speed === true,
        distance: summary.distance === true,
        coordinates: summary.coordinates === true,
        accuracy: summary.accuracy === true,
        pause: summary.pause === true
      }
    },
    fit: result?.ok ? {
      ok: true,
      runs: profile.runs,
      seconds: profile.seconds,
      pace: profile.pace,
      slow: profile.slow,
      fast: profile.fast,
      tau: profile.tau
    } : {ok: false, reason: result?.message ?? parsed?.message ?? '拟合失败。'}
  };
}

root.KeepRunImport = {parse, normalize, fit, fitHistory, sanitize, report};
if (typeof module !== 'undefined') module.exports = root.KeepRunImport;
})(typeof window === 'undefined' ? globalThis : window);
