#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { analyzeImpact, analyzeProject, mergeGraphs, traceProject } from '../src/index.js';

function usage() {
  console.log(`Code Impact Analyzer (local)

Usage:
  code-impact analyze [project-root] [file] [--function name] [--runtime] [--yes] [--json]
  code-impact trace [project-root] [entry-file] [--yes] [--timeout ms]
  code-impact impact [project-root] <file-or-function> [--function name] [--runtime] [--yes] [--json]

Runtime execution is opt-in. Use --yes for non-interactive execution after reviewing the target application.
`);
}

function parseArguments(args) {
  const options = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--function' || argument === '--entry' || argument === '--timeout') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (['--runtime', '--static', '--yes', '--json'].includes(argument)) {
      options[argument.slice(2)] = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.positional.push(argument);
    }
  }
  return options;
}

function chooseProjectAndTarget(positional) {
  const cwd = process.cwd();
  if (!positional.length) return { projectRoot: cwd, targetPath: null };

  const firstPath = path.resolve(cwd, positional[0]);
  if (fs.existsSync(firstPath) && fs.statSync(firstPath).isDirectory()) {
    return { projectRoot: firstPath, targetPath: positional[1] || null };
  }
  return { projectRoot: cwd, targetPath: positional[0] };
}

async function confirmRuntime(projectRoot, entry, acceptedByFlag) {
  if (acceptedByFlag) return true;
  const message = `Run the application at "${entry || '(detected entry point)'}" in "${projectRoot}" to capture runtime behavior? This executes project code. [y/N] `;
  if (!stdin.isTTY) {
    throw new Error('Runtime tracing needs consent. Re-run with --yes only after reviewing the application and entry point.');
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(message);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    readline.close();
  }
}

function findTargets(graph, fileArgument, functionName, projectRoot) {
  let candidates = graph.nodes;
  if (fileArgument) {
    const absolute = path.resolve(projectRoot, fileArgument);
    const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
    candidates = candidates.filter((node) => node.file === relative);
    if (candidates.length === 0) throw new Error(`No analyzed source file matches "${fileArgument}".`);
  }
  if (functionName) {
    candidates = candidates.filter((node) => (
      ['function', 'method', 'component'].includes(node.type)
      && (node.name === functionName || node.id.endsWith(`::${functionName}`))
    ));
    if (candidates.length === 0) throw new Error(`No function or component named "${functionName}" was found.`);
  } else if (!fileArgument) {
    throw new Error('Specify a file or --function target to calculate impact.');
  }
  return candidates;
}

function renderImpact(report) {
  const lines = ['CODE IMPACT ANALYZER', '', 'TARGET'];
  for (const target of report.targets) lines.push(`  ${target.id}`);
  for (const [heading, items] of [
    ['DIRECT IMPACT', report.directImpact],
    ['INDIRECT IMPACT', report.indirectImpact],
    ['OBSERVED RUNTIME IMPACT', report.observedImpact],
    ['POSSIBLE DYNAMIC IMPACT', report.possibleImpact]
  ]) {
    lines.push('', heading);
    if (!items.length) lines.push('  None detected');
    for (const item of items) {
      lines.push(`  ${item.name} (${item.file || 'unknown file'})`);
      lines.push(`    Evidence: ${item.evidence}; Confidence: ${item.confidence}`);
    }
  }
  lines.push('', `Affected files: ${report.affectedFiles.length}`);
  for (const file of report.affectedFiles) lines.push(`  ${file}`);
  lines.push(`Affected functions/components: ${report.affectedFunctions.length}`);
  lines.push(`Affected API routes: ${report.affectedRoutes.length}`);
  for (const route of report.affectedRoutes) lines.push(`  ${route.name} (${route.file})`);
  lines.push(`Affected frontend components: ${report.affectedComponents.length}`);
  for (const component of report.affectedComponents) lines.push(`  ${component.name} (${component.file})`);
  lines.push(`Risk: ${report.risk.level} (score ${report.risk.score})`);
  if (report.unknownRelationships.length) {
    lines.push(`Unresolved relationships: ${report.unknownRelationships.length}`);
    for (const relationship of report.unknownRelationships) {
      lines.push(`  ${relationship.from} -> ${relationship.expression}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const [, , command, ...rawArgs] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const options = parseArguments(rawArgs);

  if (command === 'trace') {
    const { projectRoot } = chooseProjectAndTarget(options.positional);
    const explicitEntry = options.entry || options.positional[1] || null;
    if (!await confirmRuntime(projectRoot, explicitEntry, options.yes)) {
      console.log('Runtime tracing cancelled.');
      return;
    }
    const trace = traceProject(projectRoot, explicitEntry, {
      timeout: options.timeout ? Number(options.timeout) : undefined
    });
    console.log(JSON.stringify(trace, null, 2));
    if (trace.status !== 'ok') process.exitCode = 1;
    return;
  }

  if (command !== 'analyze' && command !== 'impact') {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }

  const { projectRoot, targetPath } = chooseProjectAndTarget(options.positional);
  const report = analyzeProject(projectRoot);
  let graph = report.graph;
  let runtime = null;

  if (options.runtime) {
    const explicitEntry = options.entry || null;
    if (!await confirmRuntime(projectRoot, explicitEntry, options.yes)) {
      console.log('Runtime tracing cancelled.');
      return;
    }
    runtime = traceProject(projectRoot, explicitEntry, {
      timeout: options.timeout ? Number(options.timeout) : undefined
    });
    graph = mergeGraphs(graph, runtime);
  }

  let impact = null;
  if (targetPath || options.function) {
    const targets = findTargets(graph, targetPath, options.function, projectRoot);
    impact = analyzeImpact(graph, targets);
  }

  if (options.json) {
    console.log(JSON.stringify({
      projectRoot,
      summary: report.summary,
      target: impact?.targets || null,
      ...(impact || {}),
      ...(runtime ? { runtime } : {}),
      graph
    }, null, 2));
    return;
  }

  if (impact) {
    console.log(renderImpact(impact));
  } else {
    console.log(`CODE IMPACT ANALYZER\n\nProject: ${projectRoot}\nFiles: ${report.summary.fileCount}\nNodes: ${report.summary.nodeCount}\nEdges: ${report.summary.edgeCount}\nUnresolved relationships: ${report.summary.unresolvedCount}`);
  }
  if (runtime && runtime.status !== 'ok') console.error(`Runtime process ${runtime.status}; exit=${runtime.exitCode}; signal=${runtime.signal || 'none'}`);
  if (runtime?.warnings.length) console.error(runtime.warnings.join('\n'));
  if (runtime && runtime.status !== 'ok') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Code Impact Analyzer failed: ${error.message}`);
  process.exitCode = 1;
});
