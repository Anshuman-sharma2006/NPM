import { computeRisk } from './risk.js';

function resolveTargets(graph, target) {
  if (!target) throw new Error('An impact target is required.');
  if (Array.isArray(target)) return target.map((item) => typeof item === 'string' ? item : item.id);
  if (typeof target === 'object' && Array.isArray(target.nodes)) return target.nodes.map((node) => node.id);

  const normalized = String(target).replaceAll('\\', '/');
  const matching = graph.nodes.filter((node) => node.id === normalized
    || node.name === normalized
    || node.file === normalized
    || node.file?.endsWith(`/${normalized}`));
  if (matching.length === 0) throw new Error(`No graph node matches impact target "${target}".`);
  return matching.map((node) => node.id);
}

export function analyzeImpact(graph, target) {
  const targetIds = resolveTargets(graph, target);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const dependents = new Map();
  for (const edge of graph.edges) {
    const list = dependents.get(edge.target) || [];
    list.push(edge);
    dependents.set(edge.target, list);
  }

  const visited = new Map();
  const queue = targetIds.map((id) => ({ id, depth: 0, observed: false, possible: false }));
  while (queue.length) {
    const current = queue.shift();
    for (const edge of dependents.get(current.id) || []) {
      const id = edge.source;
      if (targetIds.includes(id)) continue;
      const observed = current.observed || edge.evidence.includes('runtime');
      const possible = current.possible || edge.evidence === 'possible';
      const previous = visited.get(id);
      if (previous && previous.depth <= current.depth + 1
        && (previous.observed || !observed)
        && (previous.possible || !possible)) continue;
      visited.set(id, {
        id,
        depth: current.depth + 1,
        observed,
        possible,
        evidence: observed ? (edge.evidence === 'static+runtime' ? 'static+runtime' : 'runtime') : possible ? 'possible' : 'static',
        confidence: observed ? 'very-high' : edge.confidence
      });
      queue.push({ id, depth: current.depth + 1, observed, possible });
    }
  }

  const impact = [...visited.values()].map((item) => {
    const node = nodeById.get(item.id);
    return {
      id: item.id,
      name: node?.name || item.id,
      type: node?.type || 'unknown',
      file: node?.file || null,
      depth: item.depth,
      evidence: item.evidence,
      confidence: item.confidence,
      classification: item.observed ? 'OBSERVED' : item.possible ? 'POSSIBLE' : item.depth === 1 ? 'DIRECT' : 'INDIRECT'
    };
  });
  const directImpact = impact.filter((item) => item.depth === 1 && !item.evidence.includes('runtime') && item.classification !== 'POSSIBLE');
  const indirectImpact = impact.filter((item) => item.depth > 1 && !item.evidence.includes('runtime') && item.classification !== 'POSSIBLE');
  const observedImpact = impact.filter((item) => item.evidence.includes('runtime'));
  const possibleImpact = impact.filter((item) => item.classification === 'POSSIBLE');
  const affectedFiles = [...new Set(impact.map((item) => item.file).filter(Boolean))].sort();
  const affectedRoutes = impact.filter((item) => item.type === 'route');
  const affectedComponents = impact.filter((item) => item.type === 'component');

  return {
    targets: targetIds.map((id) => nodeById.get(id)).filter(Boolean),
    directImpact,
    indirectImpact,
    observedImpact,
    possibleImpact,
    unknownRelationships: graph.unresolved,
    affectedFiles,
    affectedFunctions: impact.filter((item) => ['function', 'method', 'component'].includes(item.type)),
    affectedRoutes,
    affectedComponents,
    risk: computeRisk(impact, graph, targetIds),
    analysis: graph.analysis || {
      static: graph.edges.some((edge) => edge.evidence.includes('static')),
      runtime: graph.edges.some((edge) => edge.evidence.includes('runtime'))
    }
  };
}
