import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeFile, analyzeFunction, analyzeImpact, analyzeProject, mergeGraphs, traceProject } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../examples/fixture-app', import.meta.url));
const fullStackFixture = fileURLToPath(new URL('./fixtures/full-stack', import.meta.url));
const hangingFixture = fileURLToPath(new URL('./fixtures/runtime', import.meta.url));
const nodeVersion = process.versions.node.split('.').map(Number);
const supportsSynchronousEsmHooks = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 15);

test('static analysis resolves JavaScript, TypeScript, JSX, imports, routes, and function calls', () => {
  const report = analyzeProject(fullStackFixture);
  const tokenNode = report.graph.nodes.find((node) => node.id === 'src/auth/token.ts::validateToken');
  const usersNode = report.graph.nodes.find((node) => node.id === 'src/services/users.ts::getCurrentUser');
  const componentNode = report.graph.nodes.find((node) => node.id === 'components/UserPanel.tsx::UserPanel');
  const routeNode = report.graph.nodes.find((node) => node.type === 'route' && node.path === '/api/users');

  assert.ok(tokenNode);
  assert.ok(usersNode);
  assert.equal(componentNode?.type, 'component');
  assert.ok(routeNode, 'Next.js API route should be discovered');
  assert.ok(report.graph.edges.some((edge) => edge.source === usersNode.id && edge.target === tokenNode.id), 'cross-module call should resolve');
  assert.ok(report.graph.edges.some((edge) => edge.source === componentNode.id && edge.target === usersNode.id), 'JSX component call should resolve');
  assert.ok(report.graph.edges.some((edge) => edge.source === routeNode.id && edge.target.endsWith('::GET')), 'route should be connected to its handler');
});

test('impact follows reverse dependency direction and classifies direct and indirect callers', () => {
  const report = analyzeProject(fullStackFixture);
  const impact = analyzeImpact(report.graph, 'src/auth/token.ts::validateToken');

  assert.ok(impact.directImpact.some((item) => item.id === 'src/services/users.ts::getCurrentUser'));
  assert.ok(impact.indirectImpact.some((item) => item.id === 'app/api/users/route.ts::GET'));
  assert.ok(impact.indirectImpact.some((item) => item.id === 'components/UserPanel.tsx::UserPanel'));
  assert.ok(impact.affectedRoutes.length > 0);
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(impact.risk.level));
});

test('library file and function APIs include impact reports', () => {
  const fileReport = analyzeFile(fullStackFixture, 'src/auth/token.ts');
  const functionReport = analyzeFunction(fullStackFixture, 'validateToken', 'src/auth/token.ts');
  assert.equal(fileReport.target, 'src/auth/token.ts');
  assert.ok(fileReport.impact.directImpact.some((item) => item.name === 'getCurrentUser'));
  assert.equal(functionReport.nodes.length, 1);
  assert.ok(functionReport.impact.directImpact.some((item) => item.name === 'getCurrentUser'));
});

test('unresolved dynamic calls are reported as unknown and not invented as edges', () => {
  const report = analyzeProject(fullStackFixture);
  assert.ok(report.graph.unresolved.some((item) => item.file === 'dynamic/dispatch.js' && item.classification === 'UNKNOWN'));
  assert.equal(report.graph.edges.some((edge) => edge.source.includes('dispatch') && edge.target.includes('handlers')), false);
  const impact = analyzeImpact(report.graph, 'dynamic/dispatch.js::handleMessage');
  assert.ok(impact.possibleImpact.some((item) => item.id === 'dynamic/dispatch.js::installListener'));
});

test('runtime tracing records observed calls through ESM modules and closes the child process', {
  skip: !supportsSynchronousEsmHooks && 'ES module instrumentation needs Node.js 22.15 or newer'
}, () => {
  const runtimeReport = traceProject(fixtureRoot, path.join(fixtureRoot, 'index.js'));
  assert.equal(runtimeReport.status, 'ok');
  assert.ok(runtimeReport.events.some((event) => event.caller === 'checkout' && event.callee === 'createOrder'));
  assert.ok(runtimeReport.events.some((event) => event.caller === 'createOrder' && event.callee === 'validatePayment'));
  assert.ok(runtimeReport.events.every((event) => event.timestamp && Number.isInteger(event.depth)));
});

test('runtime tracing supports CommonJS modules', () => {
  const report = traceProject(hangingFixture, 'common.cjs');
  assert.equal(report.status, 'ok');
  assert.ok(report.events.some((event) => event.caller === 'parent' && event.callee === 'child'));
});

test('graph merging combines static and runtime evidence for the same call', {
  skip: !supportsSynchronousEsmHooks && 'ES module instrumentation needs Node.js 22.15 or newer'
}, () => {
  const staticReport = analyzeProject(fixtureRoot);
  const runtimeReport = traceProject(fixtureRoot, 'index.js');
  const merged = mergeGraphs(staticReport.graph, runtimeReport);
  assert.ok(merged.edges.some((edge) => edge.source === 'index.js::checkout'
    && edge.target === 'services/order.js::createOrder'
    && edge.evidence === 'static+runtime'
    && edge.confidence === 'very-high'));
});

test('impact traversal marks runtime-observed callers and direct reverse edges', {
  skip: !supportsSynchronousEsmHooks && 'ES module instrumentation needs Node.js 22.15 or newer'
}, () => {
  const staticReport = analyzeProject(fixtureRoot);
  const runtimeReport = traceProject(fixtureRoot, 'index.js');
  const merged = mergeGraphs(staticReport.graph, runtimeReport);
  const impact = analyzeImpact(merged, 'services/payment.js::validatePayment');
  assert.ok(impact.observedImpact.some((item) => item.id === 'services/order.js::createOrder'));
});

test('runtime tracing terminates long-running applications at its timeout', () => {
  const report = traceProject(hangingFixture, 'hanging.mjs', { timeout: 250 });
  assert.equal(report.status, 'timed_out');
});

test('CLI requires explicit runtime consent in non-interactive environments', () => {
  const cli = path.join(root, 'bin', 'code-impact.js');
  const result = spawnSync(process.execPath, [cli, 'trace', fixtureRoot, 'index.js'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs consent/);
});

test('CLI resolves a function target and prints reverse callers', () => {
  const cli = path.join(root, 'bin', 'code-impact.js');
  const result = spawnSync(process.execPath, [cli, 'analyze', fullStackFixture, '--function', 'validateToken'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /src\/auth\/token\.ts::validateToken/);
  assert.match(result.stdout, /getCurrentUser/);
});

test('CLI JSON output parses and retains evidence and risk fields', () => {
  const cli = path.join(root, 'bin', 'code-impact.js');
  const result = spawnSync(process.execPath, [
    cli,
    'analyze',
    fullStackFixture,
    '--function',
    'validateToken',
    '--json'
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.target[0].id, 'src/auth/token.ts::validateToken');
  assert.ok(report.directImpact.some((item) => item.id === 'src/services/users.ts::getCurrentUser'));
  assert.equal(typeof report.risk.score, 'number');
  assert.ok(report.graph.edges.every((edge) => edge.evidence && edge.confidence));
});
