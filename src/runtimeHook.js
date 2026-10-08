import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import Module from 'node:module';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(process.env.CODE_IMPACT_ROOT || process.cwd());
const outputPath = path.resolve(process.env.CODE_IMPACT_OUTPUT || path.join(projectRoot, '.code-impact/runtime/latest.json'));
const events = [];
const warnings = [];
const maxEvents = 100_000;
const context = new AsyncLocalStorage();

function writeTrace() {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({
      sessionId: process.env.CODE_IMPACT_SESSION || `session-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      truncated: events.length >= maxEvents,
      events,
      warnings
    }, null, 2));
  } catch (error) {
    console.warn(`Code Impact runtime trace could not be written to ${outputPath}: ${error.message}`);
  }
}

function functionName(node) {
  if (node.name) return node.name.getText();
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return 'anonymous';
}

function instrumentSource(source, filename, moduleFormat = 'commonjs') {
  const extension = path.extname(filename).toLowerCase();
  if (!['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'].includes(extension)) return source;

  const relativePath = path.relative(projectRoot, filename);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('node_modules')) return source;
  const relativeFile = relativePath.split(path.sep).join('/');
  const isTypeScript = ['.ts', '.mts', '.cts'].includes(extension);
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const factory = ts.factory;

  function runCall(name, body, isAsync) {
    const callbackBody = ts.isBlock(body)
      ? body
      : factory.createBlock([factory.createReturnStatement(body)], true);
    const callback = factory.createArrowFunction(
      isAsync ? [factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      callbackBody
    );
    const hook = factory.createPropertyAccessExpression(
      factory.createIdentifier('globalThis'),
      '__codeImpactRun'
    );
    return factory.createCallExpression(hook, undefined, [
      factory.createStringLiteral(name),
      factory.createStringLiteral(relativeFile),
      callback
    ]);
  }

  const transformer = (transformContext) => {
    const visit = (node) => {
      const visited = ts.visitEachChild(node, visit, transformContext);
      if (!ts.isFunctionLike(node) || !node.body || ts.isConstructorDeclaration(node) || node.asteriskToken) return visited;

      const name = functionName(node);
      const isAsync = Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
      const directives = ts.isBlock(visited.body)
        ? visited.body.statements.filter((statement) => ts.isExpressionStatement(statement)
          && ts.isStringLiteral(statement.expression))
        : [];
      const wrappedBody = factory.createBlock([
        ...directives,
        factory.createReturnStatement(runCall(name, visited.body, isAsync))
      ], true);

      if (ts.isFunctionDeclaration(visited)) {
        return factory.updateFunctionDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, wrappedBody);
      }
      if (ts.isFunctionExpression(visited)) {
        return factory.updateFunctionExpression(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, visited.parameters, visited.type, wrappedBody);
      }
      if (ts.isMethodDeclaration(visited)) {
        return factory.updateMethodDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, visited.parameters, visited.type, wrappedBody);
      }
      if (ts.isGetAccessorDeclaration(visited)) {
        return factory.updateGetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, visited.type, wrappedBody);
      }
      if (ts.isSetAccessorDeclaration(visited)) {
        return factory.updateSetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, wrappedBody);
      }
      if (ts.isArrowFunction(visited)) {
        return factory.updateArrowFunction(visited, visited.modifiers, visited.typeParameters, visited.parameters, visited.type, visited.equalsGreaterThanToken, wrappedBody);
      }
      return visited;
    };
    return (root) => ts.visitNode(root, visit);
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    const output = ts.createPrinter().printFile(transformed.transformed[0]);
    if (!isTypeScript) return output;
    return ts.transpileModule(output, {
      compilerOptions: {
        module: moduleFormat === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX
      },
      fileName: filename
    }).outputText;
  } finally {
    transformed.dispose();
  }
}

globalThis.__codeImpactRun = (name, file, callback) => {
  const parent = context.getStore();
  if (events.length < maxEvents) {
    events.push({
      caller: parent?.name || 'global',
      callerFile: parent?.file || null,
      callee: name,
      file,
      callerId: parent ? `${parent.file}::${parent.name}` : null,
      calleeId: `${file}::${name}`,
      timestamp: new Date().toISOString(),
      depth: parent ? parent.depth + 1 : 1
    });
  }
  return context.run({ name, file, depth: parent ? parent.depth + 1 : 1 }, callback);
};

process.on('beforeExit', writeTrace);
process.on('exit', writeTrace);
process.once('SIGTERM', () => {
  writeTrace();
  process.exit(143);
});

if (typeof Module.registerHooks !== 'function') {
  warnings.push('ES module runtime instrumentation requires Node.js 22.15 or newer; CommonJS tracing remains available.');
}

writeTrace();

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function codeImpactCompile(source, filename) {
  let instrumented = source;
  try {
    instrumented = instrumentSource(source, filename);
  } catch (error) {
    warnings.push(`Instrumentation skipped for ${filename}: ${error.message}`);
    console.warn(`Code Impact runtime instrumentation skipped ${filename}: ${error.message}`);
  }
  return originalCompile.call(this, instrumented, filename);
};

Module._extensions['.ts'] = function codeImpactTsLoader(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(source, filename);
};

if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    load(url, loadContext, nextLoad) {
      if (url.startsWith('file:')) {
        const filename = fileURLToPath(url);
        if (['.ts', '.mts', '.cts'].includes(path.extname(filename).toLowerCase())) {
          try {
            return {
              format: 'module',
              shortCircuit: true,
              source: instrumentSource(fs.readFileSync(filename, 'utf8'), filename, 'module')
            };
          } catch (error) {
            warnings.push(`TypeScript ESM instrumentation skipped for ${filename}: ${error.message}`);
            console.warn(`Code Impact runtime instrumentation skipped ${filename}: ${error.message}`);
          }
        }
      }
      const loaded = nextLoad(url, loadContext);
      if (loaded.format !== 'module' || !url.startsWith('file:')) return loaded;
      const filename = fileURLToPath(url);
      try {
        return {
          ...loaded,
          source: instrumentSource(String(loaded.source), filename, 'module')
        };
      } catch (error) {
        warnings.push(`ES module instrumentation skipped for ${filename}: ${error.message}`);
        console.warn(`Code Impact runtime instrumentation skipped ${filename}: ${error.message}`);
        return loaded;
      }
    }
  });
}
