import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFile, analyzeFunction, analyzeImpact, analyzeProject, traceProject } from '../src/index.js';

const nodeVersion = process.versions.node.split('.').map(Number);
const supportsSynchronousEsmHooks = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 15);

function createProject(t, name = 'code-impact-project-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relativePath, contents) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      return target;
    }
  };
}

test('resolves extension substitutions, named aliases, CommonJS require, and paths containing spaces', (t) => {
  const project = createProject(t, 'impact project with spaces ');
  project.write('src/auth/token.ts', 'export function validateToken(token: string) { return token.length > 0; }\n');
  project.write('src/api handler.js', [
    "import { validateToken as validate } from './auth/token.js';",
    'export function handler(token) { return validate(token); }'
  ].join('\n'));
  project.write('legacy/credentials.cjs', 'function check(value) { return Boolean(value); } module.exports = { check };\n');
  project.write('legacy/entry.cjs', [
    "const { check } = require('./credentials.cjs');",
    'function legacyHandler(value) { return check(value); }'
  ].join('\n'));

  const report = analyzeProject(project.root);
  assert.ok(report.graph.edges.some((edge) => edge.source === 'src/api handler.js::handler'
    && edge.target === 'src/auth/token.ts::validateToken'));
  assert.ok(report.graph.edges.some((edge) => edge.source === 'legacy/entry.cjs::legacyHandler'
    && edge.target === 'legacy/credentials.cjs::check'));
  assert.equal(report.graph.unresolved.some((item) => item.expression === 'require'), false);
  assert.equal(report.graph.nodes.some((node) => node.file.includes('node_modules')), false);
});

test('resolves default imports and namespace member calls', (t) => {
  const project = createProject(t);
  project.write('lib/default.js', 'export default function formatName(value) { return value.trim(); }\n');
  project.write('lib/tools.js', 'export function normalize(value) { return value.toLowerCase(); }\n');
  project.write('app.js', [
    "import format from './lib/default.js';",
    "import * as tools from './lib/tools.js';",
    'export function render(value) { return format(tools.normalize(value)); }'
  ].join('\n'));

  const { graph } = analyzeProject(project.root);
  assert.ok(graph.edges.some((edge) => edge.source === 'app.js::render' && edge.target === 'lib/default.js::formatName'));
  assert.ok(graph.edges.some((edge) => edge.source === 'app.js::render' && edge.target === 'lib/tools.js::normalize'));
});

test('resolves class methods, this calls, and constructor use', (t) => {
  const project = createProject(t);
  project.write('repository.js', [
    'class Repository {',
    '  find() { return this.read(); }',
    '  read() { return []; }',
    '}',
    'function createRepository() { return new Repository(); }'
  ].join('\n'));

  const { graph } = analyzeProject(project.root);
  assert.ok(graph.edges.some((edge) => edge.source === 'repository.js::Repository.find'
    && edge.target === 'repository.js::Repository.read'
    && edge.relationship === 'calls'));
  assert.ok(graph.edges.some((edge) => edge.source === 'repository.js::createRepository'
    && edge.target === 'repository.js::Repository'
    && edge.relationship === 'instantiates'));
});

test('detects React JSX components in .jsx files and arrow component declarations', (t) => {
  const project = createProject(t);
  project.write('components/Child.jsx', 'export const Child = () => <span>child</span>;\n');
  project.write('components/Parent.jsx', [
    "import { Child } from './Child.jsx';",
    'export const Parent = () => <main><Child /></main>;'
  ].join('\n'));

  const { graph } = analyzeProject(project.root);
  assert.equal(graph.nodes.find((node) => node.id === 'components/Child.jsx::Child')?.type, 'component');
  assert.equal(graph.nodes.find((node) => node.id === 'components/Parent.jsx::Parent')?.type, 'component');
});

test('discovers NodeNext TypeScript module extensions', (t) => {
  const project = createProject(t);
  project.write('src/main.mts', "import { parse } from './parser.mjs'; export function main() { return parse('ok'); }\n");
  project.write('src/parser.mts', "export function parse(value: string) { return value.trim(); }\n");
  project.write('src/legacy.cts', 'export function legacy() { return true; }\n');

  const { graph } = analyzeProject(project.root);
  assert.ok(graph.nodes.some((node) => node.id === 'src/main.mts::main'));
  assert.ok(graph.nodes.some((node) => node.id === 'src/legacy.cts::legacy'));
  assert.ok(graph.edges.some((edge) => edge.source === 'src/main.mts::main' && edge.target === 'src/parser.mts::parse'));
});

test('skips generated and dependency folders and produces stable graph identifiers', (t) => {
  const project = createProject(t);
  project.write('src/main.js', 'export function main() { return helper(); }\nfunction helper() { return true; }\n');
  project.write('node_modules/example/index.js', 'export function dependency() {}\n');
  project.write('dist/generated.js', 'export function generated() {}\n');
  project.write('.next/server/app.js', 'export function nextBuildOutput() {}\n');

  const first = analyzeProject(project.root);
  const second = analyzeProject(project.root);
  assert.equal(first.fileCount, 1);
  assert.deepEqual(first.graph.nodes.map((node) => node.id), second.graph.nodes.map((node) => node.id));
  assert.deepEqual(first.graph.edges, second.graph.edges);
});

test('reports bad project roots and unknown library targets clearly', (t) => {
  const project = createProject(t);
  project.write('source.js', 'export function known() { return 1; }\n');
  assert.throws(() => analyzeProject(path.join(project.root, 'missing')), /not a directory/);
  assert.throws(() => analyzeFile(project.root, 'missing.js'), /No analyzed source file/);
  assert.throws(() => analyzeFunction(project.root, 'missing'), /No function or component named/);
});

test('analyzes source-file targets as the union of their symbols', (t) => {
  const project = createProject(t);
  project.write('lib.js', 'export function low() { return 1; }\nexport function high() { return 2; }\n');
  project.write('consumer.js', "import { low, high } from './lib.js'; export function run() { return low() + high(); }\n");
  const report = analyzeFile(project.root, 'lib.js');
  assert.equal(report.nodes.length, 3);
  assert.ok(report.impact.directImpact.some((item) => item.name === 'run'));
});

test('impact traversal handles cycles and excludes target nodes from impact', () => {
  const graph = {
    nodes: ['a', 'b', 'c'].map((name) => ({ id: name, name, type: 'function', file: `${name}.js` })),
    edges: [
      { source: 'b', target: 'a', relationship: 'calls', evidence: 'static', confidence: 'high' },
      { source: 'c', target: 'b', relationship: 'calls', evidence: 'static', confidence: 'high' },
      { source: 'a', target: 'c', relationship: 'calls', evidence: 'static', confidence: 'high' }
    ],
    unresolved: []
  };
  const impact = analyzeImpact(graph, 'a');
  assert.deepEqual(new Set([...impact.directImpact, ...impact.indirectImpact].map((item) => item.id)), new Set(['b', 'c']));
  assert.equal([...impact.directImpact, ...impact.indirectImpact].some((item) => item.id === 'a'), false);
});

test('runtime instrumentation preserves concise arrow returns and asynchronous callback flow', {
  skip: !supportsSynchronousEsmHooks && 'ES module instrumentation needs Node.js 22.15 or newer'
}, (t) => {
  const project = createProject(t);
  project.write('app.mjs', [
    'const increment = value => value + 1;',
    'export async function main() {',
    '  return await Promise.resolve(4).then(increment);',
    '}',
    'main().then(value => console.log(`result:${value}`));'
  ].join('\n'));

  const report = traceProject(project.root, 'app.mjs', { timeout: 5_000 });
  assert.equal(report.status, 'ok', report.stderr);
  assert.match(report.stdout, /result:5/);
  assert.ok(report.events.some((event) => event.callee === 'increment'));
  assert.ok(report.events.some((event) => event.callee === 'main'));
  assert.equal(report.warnings.length, 0);
});

test('runtime instrumentation transpiles NodeNext TypeScript entry and dependency files', {
  skip: !supportsSynchronousEsmHooks && 'TypeScript ESM instrumentation needs Node.js 22.15 or newer'
}, (t) => {
  const project = createProject(t);
  project.write('app.mts', [
    "import { double } from './math.mts';",
    'export function main() {',
    '  const increment = (value: number) => value + 1;',
    '  return double(increment(2));',
    '}',
    'console.log(`result:${main()}`);'
  ].join('\n'));
  project.write('math.mts', 'export function double(value: number) { return value * 2; }\n');

  const report = traceProject(project.root, 'app.mts', { timeout: 5_000 });
  assert.equal(report.status, 'ok', report.stderr);
  assert.match(report.stdout, /result:6/);
  assert.ok(report.events.some((event) => event.callee === 'double' && event.file === 'math.mts'));
  assert.ok(report.events.some((event) => event.callee === 'increment' && event.file === 'app.mts'));
});

test('runtime reports application failures instead of making them look successful', (t) => {
  const project = createProject(t);
  project.write('fails.cjs', "function fail() { throw new Error('expected failure'); } fail();\n");
  const report = traceProject(project.root, 'fails.cjs', { timeout: 5_000 });
  assert.equal(report.status, 'error');
  assert.notEqual(report.exitCode, 0);
  assert.match(report.stderr, /expected failure/);
  assert.ok(report.events.some((event) => event.callee === 'fail'));
});

test('validates trace timeout values before starting a child process', (t) => {
  const project = createProject(t);
  project.write('app.cjs', 'module.exports = true;\n');
  assert.throws(() => traceProject(project.root, 'app.cjs', { timeout: 0 }), /positive integer/);
  assert.throws(() => traceProject(project.root, 'app.cjs', { timeout: 1.5 }), /positive integer/);
});
