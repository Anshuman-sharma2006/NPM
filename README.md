# Code Impact Analyzer

Code Impact Analyzer is a deterministic, local-only JavaScript and TypeScript developer tool. It estimates what may be affected when a function, file, API handler, or component changes by combining AST-based static analysis with optional Node.js runtime observations.

Static analysis describes relationships visible in source. Runtime analysis records functions that actually ran in one explicitly approved execution. Neither guarantees that every possible path has been found.

For component and data-flow diagrams, module responsibilities, function-level rationale, and a senior-developer guide to extending the project, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Goals and boundaries

- Runs locally; no AI, cloud service, external API, database, or API key.
- Parses JavaScript, TypeScript, JSX, and TSX with the TypeScript compiler API.
- Keeps static, runtime, and combined evidence separate on each graph edge.
- Reports unresolved dynamic relationships instead of guessing.
- Runtime tracing is opt-in, launches the chosen application in a child process, and terminates it after it exits or reaches the configured timeout.

## Install and run

Requires Node.js 18.18 or newer for the CLI and CommonJS tracing. ESM tracing uses Node's synchronous module hooks (Node.js 22.15 or newer).

### Use the published package in an application

Run these commands from the root folder of the application you want to analyze:

```powershell
npm install code-impact-analyzer
npm exec -- code-impact analyze .
```

`npm install` installs the package locally into that application. Its executable is placed in `node_modules/.bin`; PowerShell does not normally add that directory to the interactive shell's `PATH`. Therefore, use `npm exec -- code-impact ...` rather than expecting a bare `code-impact ...` command to work.

For example, to inspect a function in a real source file:

```powershell
npm exec -- code-impact analyze . src/auth/authService.ts --function validateToken
```

Replace the example file and function with paths and names that exist in your application. To produce JSON:

```powershell
npm exec -- code-impact analyze . src/auth/authService.ts --function validateToken --json
```

The equivalent direct PowerShell invocation is:

```powershell
.\node_modules\.bin\code-impact.cmd analyze .
```

Alternatively, install the package globally if you want the bare `code-impact` command available from any folder:

```powershell
npm install --global code-impact-analyzer
code-impact analyze .
```

If the package was added to your application's `package.json`, `npm ci` will install it from the lockfile. If it was not saved there, `npm ci` can remove it; install it again with `npm install code-impact-analyzer`.

Dependency audit warnings from the host application are separate from whether the CLI executable is found. Review them with `npm audit`; do not use `npm audit fix --force` without checking for potentially breaking upgrades.

If npm installs the package but `npm exec` still cannot find `code-impact`, check the installed package's `bin` declaration and version:

```powershell
npm ls code-impact-analyzer
npm view code-impact-analyzer@latest version bin
Test-Path .\node_modules\.bin\code-impact.cmd
```

The `bin` metadata should map `code-impact` to `bin/code-impact.js`. If the package/version listed by npm does not contain that mapping, the published release needs to be corrected by its maintainer.

### Run this repository from source

When developing this repository itself, install its development/runtime dependency and invoke its CLI directly:

```bash
npm install
node bin/code-impact.js analyze .
```

### Static impact analysis

```bash
# All source files in the current project
npm exec -- code-impact analyze .

# Analyze callers of every symbol in one file
npm exec -- code-impact analyze . src/auth/authService.ts

# Narrow the target to a function or component
npm exec -- code-impact analyze . src/auth/authService.ts --function validateToken

# Same target, machine-readable output
npm exec -- code-impact analyze . src/auth/authService.ts --function validateToken --json
```

The first positional argument may be a project directory. If it is a file, the current directory is the project root and the file becomes the target. Supported analysis targets include source files, functions, methods, and detected components.

### Runtime tracing

Runtime tracing executes project code. The CLI asks for consent interactively before it runs. In non-interactive contexts, tracing is refused unless `--yes` is supplied after reviewing the entry point.

```bash
npm exec -- code-impact trace . src/index.js
npm exec -- code-impact trace . src/index.js --yes --timeout 10000

# Run static analysis and merge in observations from this execution
npm exec -- code-impact analyze . src/auth/authService.ts --function validateToken --runtime
```

The default execution timeout is 30 seconds. `--timeout` is in milliseconds. The child process is waited on synchronously; it is terminated when the timeout expires. Trace metadata is stored locally at `.code-impact/runtime/latest.json`. Arguments and application payloads are not recorded; events contain function names, file paths, timestamps, and call depth.

### JSON output

Add `--json` to `analyze` or `impact` for a machine-readable report containing the target, direct/indirect/observed/possible impact, affected files, routes and components, risk breakdown, unresolved relationships, and graph evidence.

## Library API

```js
import {
  analyzeProject,
  analyzeFile,
  analyzeFunction,
  buildStaticGraph,
  traceProject,
  loadRuntimeTrace,
  mergeGraphs,
  analyzeImpact,
  CodeNode,
  CodeEdge
} from 'code-impact-analyzer';

const project = analyzeProject('./my-app');
const fileReport = analyzeFile('./my-app', 'src/auth/authService.ts');
const functionReport = analyzeFunction('./my-app', 'validateToken', 'src/auth/authService.ts');

// Call traceProject only when execution of the selected project is explicitly approved.
const runtime = traceProject('./my-app', 'src/index.js', { timeout: 10_000 });
const graph = mergeGraphs(project.graph, runtime);
const impact = analyzeImpact(graph, 'src/auth/authService.ts::validateToken');
```

`analyzeProject()` returns `{ projectRoot, generatedAt, fileCount, graph, summary, analysis }`. `traceProject()` returns process status, captured stdout/stderr, trace events, warnings, and the trace-file path. A nonzero application exit is represented as `status: "error"`; timeout is `status: "timed_out"`. Callers should inspect those fields rather than treating every trace as successful.

`analyzeFile()` and `analyzeFunction()` include their matching nodes and an `impact` report. `CodeNode` and `CodeEdge` are the graph data abstractions; their instances serialize as ordinary JSON objects.

## Analysis model

### Static code graph

The compiler AST is used to identify modules, functions, arrow functions, methods, classes, JSX components, imports, local `require()` dependencies, direct calls, and common route registrations. Relative imports are resolved across supported extensions and index files.

Common Express-style `app.get()` / `router.post()` registrations are represented as route nodes. Next.js `app/api/**/route.*` exported HTTP handlers and `pages/api/**` handlers are also detected. Framework detection is intentionally conservative; custom routers and framework abstractions may remain unresolved.

Edges point from a dependent/caller to the dependency/callee. An impact query walks these edges in reverse, from the changed node to its callers. Static direct calls and imports have high confidence. Callback registration sites such as `.on()` and `.addEventListener()` can produce `possible` edges when a callback is statically identifiable. Dynamic calls such as `handlers[key]()` are retained in `unknownRelationships` and are not turned into invented graph edges.

### Runtime graph

Runtime tracing instruments Node.js CommonJS and ES module JavaScript functions without modifying application source files. TypeScript files are transpiled for Node execution by the hook where supported. Runtime records are metadata only: caller/callee symbol IDs, file, timestamp, and depth.

Tracing observes only the paths taken in that execution. Browser-only React code, bundler-only aliases, JSX/TSX components, native addons, and unsupported loader behavior cannot be expected to execute or be observed directly in Node. ESM tracing requires Node.js 22.15 or newer; older Node versions provide a warning and can still trace CommonJS.

### Evidence and confidence

| Evidence | Meaning |
| --- | --- |
| `static` | Relationship found in source structure |
| `runtime` | Relationship observed during a traced execution |
| `static+runtime` | Both analyzers found the same edge |
| `possible` | Static syntax suggests a callback relationship, but invocation is not guaranteed |

Confidence is deterministic: resolved AST calls/imports are `high`; runtime-observed calls and matching static/runtime edges are `very-high`; statically inferred callbacks are `medium`; unresolved relationships are `low`.

### Risk score

The report exposes a transparent score breakdown. It adds capped points for affected files (up to 4), groups of affected functions (up to 3), dependency depth (up to 3), affected routes (2 each, capped at 4), affected components (up to 3), runtime-observed paths (1), and unresolved relationships attached to impacted symbols (1). Scores 0–3 are `LOW`, 4–8 `MEDIUM`, and 9 or higher `HIGH`. Risk is a prioritization aid, not a probability.

## Supported applications and limitations

The analyzer is framework-oriented but not framework-bound: it can analyze JavaScript/TypeScript Node, Express, React, Next.js, Vite, and MERN-style repositories through their source relationships. It does not execute a full browser or build pipeline. Static analysis cannot resolve every alias, reflection pattern, dynamic import, dependency-injection container, or runtime-generated function. Unsupported or unresolved relationships are surfaced as uncertainty rather than guaranteed impact.

No Git integration, GitHub integration, AI, dashboard, cloud service, or external API is included in Version 1.

## Development

```bash
npm test
```

The tests cover ESM and CommonJS tracing, TypeScript and JSX parsing, imports and calls across files, Next.js/Express-style routes, reverse impact traversal, dynamic-call uncertainty, evidence merging, CLI consent, timeout termination, project paths containing spaces, and application failures.

GitHub Actions runs the suite on Windows, macOS, and Linux with Node.js 18, 20, 22, and 24. ESM instrumentation tests are skipped on runtimes older than Node.js 22.15; CommonJS tracing and static analysis still run there.

## Make the package available to other developers

Before publishing:

1. Choose a unique npm package name. If `code-impact-analyzer` is already taken, change the `name` in `package.json`.
2. Review the package contents with `npm pack --dry-run`.
3. Run `npm ci` and `npm test`.
4. Sign in to npm with `npm login`, then publish the first public release with `npm publish --access public`.

After publishing, another developer can install and use the CLI:

```bash
npm install --global code-impact-analyzer
code-impact analyze . src/auth/authService.ts --function validateToken
```

Or run it without a global install:

```bash
npx --yes code-impact-analyzer analyze . src/auth/authService.ts --function validateToken
```

To use the programmatic API in a JavaScript project:

```bash
npm install code-impact-analyzer
```

```js
import { analyzeProject, analyzeImpact } from 'code-impact-analyzer';

const report = analyzeProject('.');
const impact = analyzeImpact(report.graph, 'src/auth/authService.ts::validateToken');
console.log(impact);
```

Publishing requires an npm account with permission to publish the selected package name. The project has not been published by this repository setup; publishing is a separate action that the maintainer must perform.
