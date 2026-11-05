import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluate} from '../../evals/assert.mjs';
import {observe as good} from '../../references/good.mjs';
import {observe as broken} from '../../references/broken.mjs';

const workload = JSON.parse(readFileSync(new URL('../../fixtures/workload.json', import.meta.url), 'utf8'));
const requirements = () => ({
  maxRequestsPerSecond: 50,
  cacheTtlMs: 30000,
  forbiddenLogFragments: ['clinicalPayload', 'diagnosis', 'glucose'],
});
const observation = (upstreamCalls, overrides = {}) => ({
  requests: upstreamCalls.map((c) => ({...c})),
  upstreamCalls,
  responses: upstreamCalls.map((c) => ({customerCode: c.customerCode, status: 'pending'})),
  logs: ['request batch completed'],
  requirements: requirements(),
  ...overrides,
});
const distinctCustomers = (n, stepMs = 10) =>
  Array.from({length: n}, (_, i) => ({customerCode: 'CUS-' + String(i).padStart(6, '0'), atMs: i * stepMs}));

function assertShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['pass', 'violations']);
  assert.equal(typeof result.pass, 'boolean');
  assert.ok(Array.isArray(result.violations));
  assert.ok(result.violations.every((v) => typeof v === 'string' && v.length > 0));
  assert.equal(result.pass, result.violations.length === 0);
}
function assertPasses(obs) {
  const result = evaluate(obs);
  assertShape(result);
  assert.deepEqual(result, {pass: true, violations: []});
}
function assertFailsWith(obs, requirementId) {
  const result = evaluate(obs);
  assertShape(result);
  assert.equal(result.pass, false);
  assert.ok(result.violations.some((v) => v.startsWith(requirementId + ':')),
    'expected a ' + requirementId + ' violation, got ' + JSON.stringify(result.violations));
}

// A valid refactor: different structure (expiry map instead of last-call map),
// several customers, different harmless log text. Behaviour is equivalent.
function refactoredObserve(requests) {
  const expiresAt = {};
  const upstreamCalls = [];
  const responses = [];
  requests.forEach(({customerCode, atMs}) => {
    if (!(customerCode in expiresAt) || atMs >= expiresAt[customerCode]) {
      upstreamCalls.push({customerCode, atMs});
      expiresAt[customerCode] = atMs + 30000;
    }
    responses.push({customerCode, status: 'pending'});
  });
  return {
    requests, upstreamCalls, responses,
    logs: ['all requests completed successfully with version 2', 'served ' + responses.length + ' status responses'],
    requirements: requirements(),
  };
}

// ---- References on the repeatable workload ----

test('good reference passes on the workload', () => {
  assertPasses(good(workload));
});

test('broken reference fails on the workload with cache and rate violations', () => {
  const obs = broken(workload);
  assertFailsWith(obs, 'CACHE-1');
  assertFailsWith(obs, 'RATE-1');
});

test('repeated reads must not overwhelm claims-core', () => {
  const requests = Array.from({length: 60}, (_, i) => ({customerCode: 'CUS-000123', atMs: i * 10}));
  assert.equal(evaluate(broken(requests)).pass, false);
});

// ---- Valid refactors ----

test('valid refactor with different harmless logs passes', () => {
  assertPasses(refactoredObserve(workload));
});

test('valid refactor with several customers and a refresh after the TTL passes', () => {
  const requests = [];
  for (let t = 0; t <= 60000; t += 500) {
    requests.push({customerCode: 'CUS-A', atMs: t}, {customerCode: 'CUS-B', atMs: t + 1});
  }
  const obs = refactoredObserve(requests);
  assert.equal(obs.upstreamCalls.length, 6); // 3 per customer: 0, 30000, 60000
  assertPasses(obs);
});

test('evaluate does not mutate the observation', () => {
  const obs = observation([{customerCode: 'A', atMs: 30000}, {customerCode: 'A', atMs: 0}]);
  const before = JSON.stringify(obs);
  evaluate(obs);
  assert.equal(JSON.stringify(obs), before);
});

// ---- CACHE-1 ----

test('CACHE-1: missing cache (every request goes upstream) fails', () => {
  const calls = Array.from({length: 5}, (_, i) => ({customerCode: 'CUS-1', atMs: i * 1000}));
  assertFailsWith(observation(calls), 'CACHE-1');
});

test('CACHE-1: refresh exactly at the TTL passes, one ms earlier fails', () => {
  assertPasses(observation([{customerCode: 'A', atMs: 0}, {customerCode: 'A', atMs: 30000}]));
  assertFailsWith(observation([{customerCode: 'A', atMs: 0}, {customerCode: 'A', atMs: 29999}]), 'CACHE-1');
});

test('CACHE-1: different customers have separate cache entries', () => {
  assertPasses(observation([{customerCode: 'A', atMs: 0}, {customerCode: 'B', atMs: 1}]));
});

// ---- RATE-1 ----

test('RATE-1: 60 requests answered by one upstream call pass', () => {
  const obs = observation([{customerCode: 'A', atMs: 0}], {requests: workload});
  assertPasses(obs);
});

test('RATE-1: 50 upstream calls within one second pass, 51 fail', () => {
  assertPasses(observation(distinctCustomers(50, 19)));
  const result = evaluate(observation(distinctCustomers(51, 19)));
  assertFailsWith(observation(distinctCustomers(51, 19)), 'RATE-1');
  assert.ok(result.violations.every((v) => v.startsWith('RATE-1:')), 'distinct customers must not trip CACHE-1');
});

test('RATE-1: a burst in a rolling window not aligned to whole seconds fails', () => {
  const calls = Array.from({length: 51}, (_, i) => ({customerCode: 'C' + i, atMs: 500 + i * 19}));
  assertFailsWith(observation(calls), 'RATE-1');
});

test('RATE-1: 51 calls spread just over one second pass', () => {
  assertPasses(observation(distinctCustomers(51, 20))); // spans 0..1000 ms
});

// ---- PRIVACY-1 ----

test('PRIVACY-1: clinical payload in a log line fails', () => {
  assertFailsWith(observation([{customerCode: 'A', atMs: 0}], {
    logs: ['request batch completed', 'upstream response clinicalPayload={"glucose":7.1}'],
  }), 'PRIVACY-1');
});

test('PRIVACY-1: a forbidden fragment embedded inside a word fails', () => {
  assertFailsWith(observation([{customerCode: 'A', atMs: 0}], {logs: ['prediagnosisCheck ok']}), 'PRIVACY-1');
});

test('PRIVACY-1: harmless log text passes', () => {
  assertPasses(observation([{customerCode: 'A', atMs: 0}], {
    logs: ['all requests completed successfully with version 2'],
  }));
});

// ---- Malformed or insufficient evidence ----

test('empty or malformed observations fail with a violation', () => {
  const cases = [
    undefined, null, 42, 'observation', [], {},
    observation([{customerCode: 'A', atMs: 0}], {requirements: undefined}),
    observation([{customerCode: 'A', atMs: 0}], {upstreamCalls: 'none'}),
    observation([{customerCode: 'A', atMs: 0}], {logs: [42]}),
    observation([{customerCode: 'A'}]),
    observation([{customerCode: 'A', atMs: 0}], {requirements: {maxRequestsPerSecond: 50, cacheTtlMs: 30000}}),
  ];
  for (const obs of cases) {
    const result = evaluate(obs);
    assertShape(result);
    assert.equal(result.pass, false, 'expected failure for ' + JSON.stringify(obs));
  }
});
