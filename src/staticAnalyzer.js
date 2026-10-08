import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CodeEdge, CodeNode } from './graph.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.code-impact']);
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
const CALLBACK_METHODS = new Set(['map', 'forEach', 'filter', 'reduce', 'some', 'every', 'then', 'catch', 'finally', 'on', 'once', 'addEventListener', 'subscribe']);

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function scriptKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (['.ts', '.mts', '.cts'].includes(extension)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function collectFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, files);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function nodeName(node) {
  if (node.name) {
    if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
    return node.name.getText();
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return 'anonymous';
}

function isFunctionNode(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function isExported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)
    || (node.parent && ts.isExportAssignment(node.parent)));
}

function isDefaultExported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    || (node.parent && ts.isExportAssignment(node.parent)));
}

function resolveLocalModule(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(candidate).toLowerCase();
  const alternateExtensions = extension === '.js' ? ['.ts', '.tsx', '.jsx']
    : extension === '.mjs' ? ['.mts']
      : extension === '.cjs' ? ['.cts']
        : [];
  const candidates = extension
    ? [candidate, ...alternateExtensions.map((alternative) => `${candidate.slice(0, -extension.length)}${alternative}`)]
    : [candidate, ...RESOLVE_EXTENSIONS.map((item) => `${candidate}${item}`), ...RESOLVE_EXTENSIONS.map((item) => path.join(candidate, `index${item}`))];
  const match = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!match) return null;
  const relative = path.relative(root, match);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : match;
}

function containsJsx(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found && containsJsx(child)) found = true; });
  return found;
}

function resolveCallTarget(name, fileRelative, symbolsByFile, imports, exportedSymbolsByFile, classScope) {
  const imported = imports.get(fileRelative);
  if (name.startsWith('this.') && classScope) {
    const target = `${fileRelative}::${classScope}.${name.slice(5)}`;
    if (symbolsByFile.get(fileRelative)?.has(target)) return target;
  }

  const segments = name.split('.');
  const simpleName = segments[segments.length - 1];
  if (imported?.has(segments[0])) {
    const binding = imported.get(segments[0]);
    const exportName = segments.length > 1 ? segments.slice(1).join('.') : binding.importedName;
    if (binding.file) {
      const target = exportedSymbolsByFile.get(binding.file)?.get(exportName) || `${binding.file}::${exportName}`;
      if (symbolsByFile.get(binding.file)?.has(target)) return target;
      return null;
    }
  }

  const local = symbolsByFile.get(fileRelative);
  if (local?.has(`${fileRelative}::${name}`)) return `${fileRelative}::${name}`;
  if (local?.has(`${fileRelative}::${simpleName}`)) return `${fileRelative}::${simpleName}`;
  return null;
}

export function analyzeProject(projectRoot) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }

  const files = collectFiles(root);
  const nodes = new Map();
  const edges = new Map();
  const unresolved = [];
  const sources = [];
  const symbolsByFile = new Map();
  const exportedSymbolsByFile = new Map();
  const imports = new Map();
  const functionIds = new WeakMap();

  const addNode = (id, name, type, file, properties = {}) => {
    if (!nodes.has(id)) nodes.set(id, new CodeNode({ id, name, type, file, ...properties }));
    return id;
  };
  const addEdge = (source, target, relationship, confidence = 'high', evidence = 'static') => {
    const key = `${source}->${target}:${relationship}`;
    const existing = edges.get(key);
    if (existing) return;
    edges.set(key, new CodeEdge({ source, target, relationship, evidence, confidence }));
  };

  for (const filePath of files) {
    const file = normalizePath(path.relative(root, filePath));
    const text = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
    const fileSymbols = new Set();
    const fileExports = new Map();
    let frameworkRoute = null;
    sources.push({ file, filePath, sourceFile });
    symbolsByFile.set(file, fileSymbols);
    exportedSymbolsByFile.set(file, fileExports);
    addNode(`${file}::module`, 'module', 'module', file);
    const segments = file.split('/');
    const appApiIndex = segments.findIndex((segment, index) => segment === 'api' && segments.slice(0, index).includes('app'));
    const pagesApiIndex = segments.findIndex((segment, index) => segment === 'api' && segments.slice(0, index).includes('pages'));
    if (appApiIndex >= 0 && segments.at(-1).startsWith('route.')) {
      const routePath = segments.slice(appApiIndex + 1, -1).join('/');
      frameworkRoute = { path: routePath ? `/api/${routePath}` : '/api', pagesApi: false };
    } else if (pagesApiIndex >= 0) {
      const routePath = `/${segments.slice(pagesApiIndex).join('/').replace(/\.[^.]+$/, '')}`;
      frameworkRoute = { path: routePath.replace(/\/index$/, '') || '/api', pagesApi: true };
    }

    function collect(node, className = null) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const name = nodeName(node);
        const exported = isExported(node);
        const classId = `${file}::${name}`;
        addNode(classId, name, 'class', file, { exported });
        fileSymbols.add(`${file}::${name}`);
        if (exported) fileExports.set(isDefaultExported(node) ? 'default' : name, classId);
        ts.forEachChild(node, (child) => collect(child, name));
        return;
      }

      if (isFunctionNode(node)) {
        const name = nodeName(node);
        const isMethod = ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
        const qualifiedName = isMethod && className ? `${className}.${name}` : name;
        const component = !isMethod && /^[A-Z]/.test(name) && containsJsx(node);
        const id = `${file}::${qualifiedName}`;
        const exported = isExported(node) || isExported(node.parent);
        addNode(id, qualifiedName, component ? 'component' : isMethod ? 'method' : 'function', file, {
          exported,
          async: Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
          parameters: node.parameters.length
        });
        fileSymbols.add(id);
        if (exported) fileExports.set(isDefaultExported(node) ? 'default' : name, id);
        functionIds.set(node, id);
        if (isMethod && className) addEdge(`${file}::${className}`, id, 'contains');
        if (frameworkRoute && (frameworkRoute.pagesApi ? isDefaultExported(node) : isExported(node))) {
          const method = frameworkRoute.pagesApi ? 'ALL' : name.toUpperCase();
          if (frameworkRoute.pagesApi || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
            const routeName = `${method} ${frameworkRoute.path}`;
            const routeId = addNode(`${file}::${routeName}`, routeName, 'route', file, { method, path: frameworkRoute.path });
            addEdge(routeId, id, 'calls');
          }
        }
        ts.forEachChild(node, (child) => collect(child, className));
        return;
      }

      if (ts.isVariableDeclaration(node) && node.initializer && isFunctionNode(node.initializer)) {
        const name = nodeName(node);
        const id = `${file}::${name}`;
        const initializer = node.initializer;
        const component = /^[A-Z]/.test(name) && containsJsx(node.initializer);
        const exported = isExported(node.parent?.parent);
        addNode(id, name, component ? 'component' : 'function', file, {
          exported,
          async: Boolean(initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
          parameters: initializer.parameters.length
        });
        fileSymbols.add(id);
        if (exported) fileExports.set(isDefaultExported(node.parent?.parent) ? 'default' : name, id);
        functionIds.set(initializer, id);
        ts.forEachChild(initializer, (child) => collect(child, className));
        return;
      }

      ts.forEachChild(node, (child) => collect(child, className));
    }

    collect(sourceFile);
  }

  for (const { file, filePath, sourceFile } of sources) {
    const bindings = new Map();
    imports.set(file, bindings);

    function collectImports(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetPath = resolveLocalModule(root, filePath, node.moduleSpecifier.text);
        if (targetPath) {
          const targetFile = normalizePath(path.relative(root, targetPath));
          const clause = node.importClause;
          if (clause?.name) bindings.set(clause.name.text, { file: targetFile, importedName: 'default' });
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              bindings.set(element.name.text, { file: targetFile, importedName: (element.propertyName || element.name).text });
            }
          } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            bindings.set(clause.namedBindings.name.text, { file: targetFile, importedName: 'namespace' });
          }
          addEdge(`${file}::module`, `${targetFile}::module`, 'depends-on');
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const expression = node.initializer.expression;
        const isRequire = ts.isIdentifier(expression) && expression.text === 'require';
        const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
        const specifier = node.initializer.arguments[0];
        if ((isRequire || isDynamicImport) && specifier && ts.isStringLiteralLike(specifier)) {
          const targetPath = resolveLocalModule(root, filePath, specifier.text);
          if (targetPath) {
            const targetFile = normalizePath(path.relative(root, targetPath));
            if (ts.isIdentifier(node.name)) bindings.set(node.name.text, { file: targetFile, importedName: 'default' });
            if (ts.isObjectBindingPattern(node.name)) {
              for (const element of node.name.elements) {
                const localName = element.name.getText();
                const importedName = element.propertyName?.getText() || localName;
                bindings.set(localName, { file: targetFile, importedName });
              }
            }
            addEdge(`${file}::module`, `${targetFile}::module`, 'depends-on');
          }
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const specifier = node.arguments[0];
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const targetPath = resolveLocalModule(root, filePath, specifier.text);
          if (targetPath) {
            const targetFile = normalizePath(path.relative(root, targetPath));
            addEdge(`${file}::module`, `${targetFile}::module`, 'depends-on');
          }
        }
      }
      ts.forEachChild(node, collectImports);
    }
    collectImports(sourceFile);

    function collectCalls(node, scope = [], className = null) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const nextClass = nodeName(node);
        ts.forEachChild(node, (child) => collectCalls(child, scope, nextClass));
        return;
      }
      if (isFunctionNode(node)) {
        const id = functionIds.get(node) || `${file}::${nodeName(node)}`;
        const nextScope = [...scope, id];
        ts.forEachChild(node, (child) => collectCalls(child, nextScope, className));
        return;
      }
      if (ts.isNewExpression(node)) {
        const name = node.expression.getText(sourceFile);
        const caller = scope.at(-1) || `${file}::module`;
        const target = resolveCallTarget(name, file, symbolsByFile, imports, exportedSymbolsByFile, className);
        if (target) addEdge(caller, target, 'instantiates', 'high');
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(sourceFile);
        const caller = scope.at(-1) || `${file}::module`;
        const target = resolveCallTarget(name, file, symbolsByFile, imports, exportedSymbolsByFile, className);
        const callbackMethod = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
        let hasResolvedCallback = false;
        if (CALLBACK_METHODS.has(callbackMethod)) {
          for (const argument of node.arguments) {
            const callbackId = ts.isIdentifier(argument)
              ? resolveCallTarget(argument.text, file, symbolsByFile, imports, exportedSymbolsByFile, className)
              : functionIds.get(argument);
            if (callbackId) {
              addEdge(caller, callbackId, 'may-call', 'medium', 'possible');
              hasResolvedCallback = true;
            }
          }
        }
        const unresolvedDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
          && !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]));
        const unresolvedDynamicRequire = name === 'require'
          && !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]));
        if (target) {
          addEdge(caller, target, 'calls', 'high');
        } else if (unresolvedDynamicImport || unresolvedDynamicRequire || name.includes('[')) {
          unresolved.push({ from: caller, expression: name, file, relationship: 'dynamic-call', classification: 'UNKNOWN', confidence: 'low' });
        } else {
          const simpleName = name.split('.').at(-1);
          const literalModuleLoad = name === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword;
          if (!literalModuleLoad && !hasResolvedCallback && simpleName && !symbolsByFile.get(file).has(`${file}::${simpleName}`)) {
            unresolved.push({ from: caller, expression: name, file, relationship: 'calls', classification: 'UNKNOWN', confidence: 'low' });
          }
        }

        const memberName = name;
        const routeMatch = /^(?:router|app|(?:\w+Router))\.(get|post|put|delete|patch|all|use)$/.exec(memberName);
        if (routeMatch) {
          const method = routeMatch[1].toUpperCase();
          const routeArgument = node.arguments[0];
          const routePath = routeArgument && ts.isStringLiteralLike(routeArgument) ? routeArgument.text : '*';
          const routeName = `${method} ${routePath}`;
          const routeId = addNode(`${file}::${routeName}`, routeName, 'route', file, { method, path: routePath });
          addEdge(`${file}::module`, routeId, 'registers', routeArgument && routePath !== '*' ? 'high' : 'medium');
          for (const handler of node.arguments.slice(routeArgument ? 1 : 0)) {
            const handlerName = ts.isIdentifier(handler) ? handler.text : null;
            const handlerId = handlerName
              ? resolveCallTarget(handlerName, file, symbolsByFile, imports, exportedSymbolsByFile, className)
              : functionIds.get(handler);
            if (handlerId) addEdge(routeId, handlerId, 'calls');
          }
        }
      }
      ts.forEachChild(node, (child) => collectCalls(child, scope, className));
    }
    collectCalls(sourceFile);
  }

  return {
    projectRoot: root,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    graph: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      unresolved,
      analysis: { static: true, runtime: false }
    }
  };
}
