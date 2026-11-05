// Policy eval for the live-status feature.
// evaluate(observation) inspects one recorded run and returns {pass, violations}.
// It never mutates the observation: arrays are copied before sorting.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isEvent(value) {
  return isPlainObject(value)
    && typeof value.customerCode === 'string'
    && value.customerCode.length > 0
    && typeof value.atMs === 'number'
    && Number.isFinite(value.atMs);
}

// Structural checks. Returns a list of violations; an empty list means the
// observation is complete enough to evaluate the requirements.
function checkEvidence(observation) {
  if (!isPlainObject(observation)) {
    return ['EVIDENCE: observation must be an object'];
  }
  const problems = [];
  const req = observation.requirements;
  if (!isPlainObject(req)) {
    problems.push('EVIDENCE: observation.requirements is missing');
  } else {
    if (!isPositiveNumber(req.maxRequestsPerSecond)) {
      problems.push('EVIDENCE: requirements.maxRequestsPerSecond must be a positive number');
    }
    if (!isPositiveNumber(req.cacheTtlMs)) {
      problems.push('EVIDENCE: requirements.cacheTtlMs must be a positive number');
    }
    const fragments = req.forbiddenLogFragments;
    if (!Array.isArray(fragments)
      || !fragments.every((f) => typeof f === 'string' && f.length > 0)) {
      problems.push('EVIDENCE: requirements.forbiddenLogFragments must be an array of non-empty strings');
    }
  }
  for (const field of ['requests', 'upstreamCalls', 'responses', 'logs']) {
    if (!Array.isArray(observation[field])) {
      problems.push('EVIDENCE: observation.' + field + ' must be an array');
    }
  }
  for (const field of ['requests', 'upstreamCalls']) {
    const list = observation[field];
    if (Array.isArray(list)) {
      const bad = list.findIndex((item) => !isEvent(item));
      if (bad !== -1) {
        problems.push('EVIDENCE: ' + field + '[' + bad + '] must have a string customerCode and a finite numeric atMs');
      }
    }
  }
  if (Array.isArray(observation.logs)) {
    const bad = observation.logs.findIndex((line) => typeof line !== 'string');
    if (bad !== -1) {
      problems.push('EVIDENCE: logs[' + bad + '] must be a string');
    }
  }
  return problems;
}

// CACHE-1: per customer, consecutive upstream calls must be at least
// cacheTtlMs apart. A refresh exactly cacheTtlMs later is valid.
function checkCache(upstreamCalls, cacheTtlMs) {
  const timesByCustomer = new Map();
  for (const call of upstreamCalls) {
    if (!timesByCustomer.has(call.customerCode)) timesByCustomer.set(call.customerCode, []);
    timesByCustomer.get(call.customerCode).push(call.atMs);
  }
  const violations = [];
  for (const [customerCode, times] of timesByCustomer) {
    times.sort((a, b) => a - b); // local copy, not the observation
    let repeats = 0;
    let first = null;
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap < cacheTtlMs) {
        repeats += 1;
        if (first === null) first = { at: times[i], gap };
      }
    }
    if (repeats > 0) {
      violations.push('CACHE-1: customer ' + customerCode + ' had ' + repeats
        + ' upstream call(s) within ' + cacheTtlMs + ' ms of the previous call (first at '
        + first.at + ' ms, ' + first.gap + ' ms after the previous)');
    }
  }
  return violations;
}

// RATE-1: in any rolling one-second window [t, t + 1000), the number of
// upstream calls must not exceed maxRequestsPerSecond. The busiest window
// can always be shifted to start at a call, so checking each call's start
// time covers every window.
function checkRate(upstreamCalls, maxRequestsPerSecond) {
  const times = upstreamCalls.map((call) => call.atMs).sort((a, b) => a - b);
  let worst = 0;
  let worstStart = 0;
  let end = 0;
  for (let start = 0; start < times.length; start += 1) {
    if (end < start) end = start;
    while (end < times.length && times[end] < times[start] + 1000) end += 1;
    const count = end - start;
    if (count > worst) {
      worst = count;
      worstStart = times[start];
    }
  }
  if (worst > maxRequestsPerSecond) {
    return ['RATE-1: ' + worst + ' upstream calls in the one-second window starting at '
      + worstStart + ' ms (max ' + maxRequestsPerSecond + ')'];
  }
  return [];
}

// PRIVACY-1: no log line may contain any forbidden fragment.
function checkPrivacy(logs, forbiddenLogFragments) {
  const violations = [];
  logs.forEach((line, index) => {
    const found = forbiddenLogFragments.filter((fragment) => line.includes(fragment));
    if (found.length > 0) {
      violations.push('PRIVACY-1: logs[' + index + '] contains forbidden fragment(s): ' + found.join(', '));
    }
  });
  return violations;
}

export function evaluate(observation) {
  let violations;
  try {
    violations = checkEvidence(observation);
    if (violations.length === 0) {
      const req = observation.requirements;
      violations = [
        ...checkCache(observation.upstreamCalls, req.cacheTtlMs),
        ...checkRate(observation.upstreamCalls, req.maxRequestsPerSecond),
        ...checkPrivacy(observation.logs, req.forbiddenLogFragments),
      ];
    }
  } catch (error) {
    violations = ['EVIDENCE: observation could not be evaluated (' + String(error && error.message ? error.message : error) + ')'];
  }
  return { pass: violations.length === 0, violations };
}
