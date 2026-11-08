(function (root) {
'use strict';
const key = 'shou.personal-pace.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const left = Math.floor(position);
  return sorted[left] + (sorted[Math.ceil(position)] - sorted[left]) * (position - left);
}

function fit(runs) {
  const offsets = [], changes = [], pairs = [], paces = [];
  for (const run of runs) {
    const speeds = run.flat();
    if (speeds.length < 3) continue;
    const typical = quantile(speeds, .5);
    paces.push(1000 / typical);
    for (const segment of run) {
      const residuals = segment.map(speed => clamp(Math.log(speed / typical), -.35, .35));
      offsets.push(...residuals);
      for (let i = 1; i < residuals.length; i++) {
        pairs.push([residuals[i - 1], residuals[i]]);
        changes.push(Math.abs(residuals[i] - residuals[i - 1]));
      }
    }
  }
  if (offsets.length < 6 || pairs.length < 4) throw Error('有效速度样本不足。需要至少 30 秒可用 GPS 速度，请结束并保存更多跑步记录。');

  const weight = offsets.length / (offsets.length + 24);
  const spread = (quantile(offsets, .84) - quantile(offsets, .16)) / 2;
  const fast = clamp(quantile(changes, .5) / .954, .004, .08);
  const slow = clamp(Math.sqrt(Math.max(0, spread ** 2 - fast ** 2)), .008, .18);

  const center = quantile(offsets, .5);
  let covariance = 0, before = 0, after = 0;
  for (const [a, b] of pairs) {
    covariance += (a - center) * (b - center);
    before += (a - center) ** 2;
    after += (b - center) ** 2;
  }
  const pairWeight = before * after > 1e-9 ? pairs.length / (pairs.length + 24) : 0;
  const correlation = pairWeight ? clamp(covariance / Math.sqrt(before * after), .55, .94) : 0;
  const tau = pairWeight ? 40 * (1 - pairWeight) + (-5 / Math.log(correlation)) * pairWeight : 40;

  return {
    slow: .044 * (1 - weight) + slow * weight,
    fast: .008 * (1 - weight) + fast * weight,
    tau,
    seconds: offsets.length * 5,
    runs: paces.length,
    pace: quantile(paces, .5)
  };
}

function load() {
  try {
    const state = JSON.parse(root.localStorage.getItem(key));
    const profile = state?.profile;
    if (profile && ['slow', 'fast', 'tau', 'seconds', 'runs', 'pace'].every(name =>
      Number.isFinite(profile[name]) && profile[name] > 0)) {
      return {profile, enabled: state.enabled === true};
    }
  } catch (_) {
    // Missing storage or an invalid record leaves the default generator available.
  }
  return {profile: null, enabled: false};
}

let current = load();
function save(profile, enabled) {
  const next = {profile, enabled: Boolean(profile && enabled)};
  if (profile) root.localStorage.setItem(key, JSON.stringify(next));
  else root.localStorage.removeItem(key);
  current = next;
}

root.RunPaceProfile = {fit, get: () => current, save};
if (typeof module !== 'undefined') module.exports = root.RunPaceProfile;
})(typeof window === 'undefined' ? globalThis : window);
