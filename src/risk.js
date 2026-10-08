export function computeRisk(impact, graph, targetIds) {
  const files = new Set(impact.map((item) => item.file).filter(Boolean));
  const routes = impact.filter((item) => item.type === 'route').length;
  const components = impact.filter((item) => item.type === 'component').length;
  const functions = impact.filter((item) => ['function', 'method', 'component'].includes(item.type)).length;
  const observed = impact.filter((item) => item.evidence.includes('runtime')).length;
  const relevantNodeIds = new Set([...targetIds, ...impact.map((item) => item.id)]);
  const unresolved = graph.unresolved.filter((item) => relevantNodeIds.has(item.from)).length;
  const maxDepth = impact.reduce((max, item) => Math.max(max, item.depth), 0);
  const breakdown = {
    affectedFiles: Math.min(files.size, 4),
    affectedFunctions: Math.min(Math.ceil(functions / 3), 3),
    dependencyDepth: Math.min(maxDepth, 3),
    affectedRoutes: Math.min(routes * 2, 4),
    affectedComponents: Math.min(components, 3),
    runtimeObserved: observed > 0 ? 1 : 0,
    unresolvedRelationships: unresolved > 0 ? 1 : 0
  };
  const score = Object.values(breakdown).reduce((total, value) => total + value, 0);
  return { level: score >= 9 ? 'HIGH' : score >= 4 ? 'MEDIUM' : 'LOW', score, breakdown };
}
