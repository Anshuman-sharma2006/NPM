import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeProject as analyzeStaticProject } from './staticAnalyzer.js';
import { analyzeImpact } from './impact.js';
import { CodeEdge, CodeNode } from './graph.js';

export { analyzeImpact, CodeEdge, CodeNode };

const runtimeHookPath = fileURLToPath(new URL('./runtimeHook.js', import.meta.url));

export function analyzeProject(projectRoot) {
  const report = analyzeStaticProject(projectRoot);
  return {
    ...report,
    summary: {
      fileCount: report.fileCount,
      nodeCount: report.graph.nodes.length,
      edgeCount: report.graph.edges.length,
      unresolvedCount: report.graph.unresolved.length
    },
    analysis: { static: true, runtime: false }
  };
}

export function analyzeFile(projectRoot, filePath) {
  const report = analyzeProject(projectRoot);
  const normalizedTarget = path.resolve(projectRoot, filePath);
  const relativeTarget = path.relative(path.resolve(projectRoot), normalizedTarget).split(path.sep).join('/');
  const nodes = report.graph.nodes.filter((node) => node.file === relativeTarget);
  if (!nodes.length) throw new Error(`No analyzed source file matches "${filePath}".`);
  return { ...report, target: relativeTarget, nodes, impact: analyzeImpact(report.graph, nodes) };
}

export function analyzeFunction(projectRoot, functionName, filePath) {
  const report = analyzeProject(projectRoot);
  const normalizedFile = filePath
    ? path.relative(path.resolve(projectRoot), path.resolve(projectRoot, filePath)).split(path.sep).join('/')
    : null;
  const nodes = report.graph.nodes.filter((node) => (
    ['function', 'method', 'component'].includes(node.type)
    && (node.name === functionName || node.id.endsWith(`::${functionName}`))
    && (!normalizedFile || node.file === normalizedFile)
  ));
  if (!nodes.length) throw new Error(`No function or component named "${functionName}" was found.`);
  return { ...report, target: functionName, nodes, impact: analyzeImpact(report.graph, nodes) };
}

export function loadRuntimeTrace(tracePath) {
  const absolutePath = path.resolve(tracePath);
  const trace = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  if (!Array.isArray(trace.events)) {
    throw new Error(`Runtime trace does not contain an events array: ${absolutePath}`);
  }
  return { ...trace, traceFile: absolutePath };
}

export function traceProject(projectRoot, entryScript, options = {}) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }

  const script = entryScript
    ? path.resolve(root, entryScript)
    : (() => {
        const packagePath = path.join(root, 'package.json');
        if (fs.existsSync(packagePath)) {
          const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
          if (packageJson.main) return path.resolve(root, packageJson.main);
        }
        return ['index.js', 'src/index.js', 'server.js', 'app.js']
          .map((candidate) => path.resolve(root, candidate))
          .find((candidate) => fs.existsSync(candidate)) || '';
      })();

  if (!script || !fs.existsSync(script) || !fs.statSync(script).isFile()) {
    throw new Error(`Unable to locate a valid Node.js entry file under ${root}. Provide an entry file explicitly.`);
  }

  const timeout = options.timeout ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('Runtime trace timeout must be a positive integer number of milliseconds.');
  }

  const sessionId = randomUUID();
  const outputPath = path.join(root, '.code-impact', 'runtime', 'latest.json');
  const environment = {
    ...process.env,
    CODE_IMPACT_OUTPUT: outputPath,
    CODE_IMPACT_ROOT: root,
    CODE_IMPACT_SESSION: sessionId
  };
  const args = ['--import', pathToFileURL(runtimeHookPath).href, script, ...(options.args || [])];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGTERM',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;

  const payload = fs.existsSync(outputPath)
    ? loadRuntimeTrace(outputPath)
    : { events: [], warnings: ['The application exited before the tracer could write a trace file.'] };

  return {
    projectRoot: root,
    entryScript: script,
    status: result.error?.code === 'ETIMEDOUT' ? 'timed_out' : result.status === 0 ? 'ok' : 'error',
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    events: payload.events || [],
    warnings: payload.warnings || [],
    traceFile: outputPath,
    sessionId
  };
}

export function mergeGraphs(staticGraph, runtimeTrace) {
  const nodes = new Map((staticGraph.nodes || []).map((node) => [node.id, new CodeNode(node)]));
  const edges = new Map();
  const unresolved = [...(staticGraph.unresolved || [])];

  for (const edge of staticGraph.edges || []) {
    edges.set(`${edge.source}->${edge.target}:${edge.relationship}`, new CodeEdge(edge));
  }

  for (const event of runtimeTrace.events || []) {
    const callerId = event.callerId || `${event.file}::module`;
    const calleeId = event.calleeId || `${event.file}::${event.callee}`;
    nodes.set(callerId, nodes.get(callerId) || new CodeNode({
      id: callerId,
      name: event.caller || 'module',
      type: 'runtime-symbol',
      file: event.callerFile || event.file
    }));
    nodes.set(calleeId, nodes.get(calleeId) || new CodeNode({
      id: calleeId,
      name: event.callee,
      type: 'runtime-symbol',
      file: event.file
    }));
    const key = `${callerId}->${calleeId}:calls`;
    const existing = edges.get(key);
    if (existing) {
      existing.evidence = 'static+runtime';
      existing.confidence = 'very-high';
    } else {
      edges.set(key, new CodeEdge({
        source: callerId,
        target: calleeId,
        relationship: 'calls',
        evidence: 'runtime',
        confidence: 'very-high'
      }));
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    unresolved,
    analysis: {
      static: staticGraph.analysis?.static ?? (staticGraph.edges || []).some((edge) => edge.evidence.includes('static')),
      runtime: Boolean(runtimeTrace.sessionId)
    }
  };
}

export function buildStaticGraph(projectRoot) {
  return analyzeProject(projectRoot).graph;
}

export default {
  analyzeProject,
  analyzeFile,
  analyzeFunction,
  buildStaticGraph,
  loadRuntimeTrace,
  traceProject,
  mergeGraphs,
  analyzeImpact,
  CodeNode,
  CodeEdge
};
