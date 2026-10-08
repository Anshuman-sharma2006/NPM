# Code Impact Analyzer: Commands and How It Works

This guide is for a developer who is new to the package. It explains what to type in Windows PowerShell, what the command does, and which parts of the analyzer help produce the result.

## The one-sentence idea

Code Impact Analyzer helps answer:

> “If I change this function or file, what other parts of my application may depend on it?”

It can inspect source code without running the application. It can also optionally run a Node.js entry point to observe which functions execute. Static analysis and runtime tracing provide different evidence; neither promises to find every possible behavior.

## Before starting

Open PowerShell in the root folder of the application you want to inspect. This is usually the folder containing that application's `package.json`.

```powershell
Set-Location "C:\path\to\your\application"
```

Check that Node.js and npm are available:

```powershell
node --version
npm --version
```

The package requires Node.js 18.18 or newer. Runtime tracing of ES modules and TypeScript ES modules needs Node.js 22.15 or newer.

## Step 1: Install the package in your application

Run this once from the application root:

```powershell
npm install --save-dev code-impact-analyzer
```

This adds the analyzer to the application's development dependencies and records it in `package.json` and `package-lock.json`. The executable is installed locally under `node_modules`.

Check the registry version if needed:

```powershell
npm view code-impact-analyzer version
```

## Step 2: Ask npm to run the analyzer

First check the available command options:

```powershell
npm exec -- code-impact --help
```

Then analyze the current application:

```powershell
npm exec -- code-impact analyze .
```

### What does `npm exec --` mean?

- `npm exec` asks npm to run a command installed in this project.
- `--` tells npm that its own options have ended.
- `code-impact analyze .` is the command passed to the analyzer.
- `.` means “the current folder.”

PowerShell may not recognize a locally installed `code-impact` command by itself. Use `npm exec -- code-impact ...` or the local Windows command shim:

```powershell
.\node_modules\.bin\code-impact.cmd analyze .
```

## Commands for everyday work

### Analyze a whole project

```powershell
npm exec -- code-impact analyze .
```

**Use this when:** you want a quick summary of discovered source files, symbols, relationships, and unresolved calls.

**What happens:** the analyzer scans supported JavaScript and TypeScript source files and parses them with the TypeScript compiler's AST. It does not run your application.

### See what could be affected by a file change

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts
```

Replace the example path with a source file that exists in your application. The path is relative to the application root.

**Use this when:** you are changing a file and want a report of callers and dependents of the symbols in that file.

### Focus on one function or component

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts --function validateToken
```

Replace both the example path and function name with names from your source. You can search by function name without giving a file:

```powershell
npm exec -- code-impact analyze . --function validateToken
```

**Use this when:** you know the exact function or component you plan to change. If the name exists in multiple files, include the file path to narrow the target.

### Save a JSON report

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts --function validateToken --json
```

To save it to a file in PowerShell:

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts --function validateToken --json |
  Set-Content -Encoding utf8 impact-report.json
```

**Use this when:** you need the report in another tool or want to save it for later. The JSON includes the target, impact categories, files, routes, components, evidence, confidence, risk, and graph.

## What `analyze` does inside the code

The command is handled by `bin/code-impact.js`. It reads the command and options, calls the public library API in `src/index.js`, then prints the result.

The static analyzer in `src/staticAnalyzer.js`:

1. Finds JavaScript, TypeScript, JSX, and TSX files, while skipping common dependency/build folders.
2. Parses source code as an AST, which means it looks at the code's structure rather than searching text with regular expressions.
3. Records symbols such as modules, functions, methods, classes, components, and supported API routes.
4. Tries to connect local imports and direct function calls across files.
5. Records dynamic calls it cannot confidently resolve as unknown instead of pretending it knows the target.

The graph stores links from a caller/dependent to the code it uses. `src/impact.js` follows those links backward from the selected target to find callers. It labels them as direct, indirect, observed, or possible, depending on the relationship and evidence.

`src/confidence.js` maps evidence to confidence. `src/risk.js` calculates a transparent score using the impact size and other factors. Risk is a review-priority aid, not a guarantee that a change will break the application.

## Optional: runtime tracing

Runtime tracing is different from `analyze`: **it executes application code**. Only trace an entry point you have reviewed and are willing to run.

### Trace a Node.js entry file

```powershell
npm exec -- code-impact trace . src\server.js
```

The CLI asks for approval in an interactive PowerShell window. Enter `y` to run it or `n` to cancel. The default timeout is 30 seconds. To set a shorter timeout of 10 seconds:

```powershell
npm exec -- code-impact trace . src\server.js --timeout 10000
```

The child process ends when the application exits or the timeout is reached. Trace metadata is written locally to:

```text
.code-impact\runtime\latest.json
```

The trace records function names, files, timestamps, and call depth. It does not record function arguments or return values. It only represents the paths exercised by that one run.

### Run a target analysis with runtime evidence

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts --function validateToken --runtime
```

The analyzer asks before starting the app. In a non-interactive terminal, explicitly approving with `--yes` is required:

```powershell
npm exec -- code-impact analyze . src\auth\authService.ts --function validateToken --runtime --yes
```

Only use `--yes` after checking which entry point will execute. For non-interactive tracing, you can specify the entry point and timeout:

```powershell
npm exec -- code-impact trace . dist\server.js --yes --timeout 10000
```

### If your TypeScript entry point fails

Runtime tracing launches Node.js directly; it does not automatically use every framework's dev server, bundler, or TypeScript runner. For example, a TypeScript server may import `./app`, while Node cannot resolve that extensionless import in the way the project's development tool does. In that case, the trace exits with an error and no useful runtime events.

First use static analysis; it does not require the app to start:

```powershell
npm exec -- code-impact analyze . src\utils\uploadFile.ts --function uploadFile
```

To investigate how the backend normally runs, inspect its scripts and TypeScript settings:

```powershell
Get-Content .\package.json
Get-Content .\tsconfig.json
```

If the project has a build command and produces a plain Node.js JavaScript entry point, build it and trace the actual generated file. The paths below are examples—use the output that your project really creates:

```powershell
npm run build
npm exec -- code-impact trace . dist\server.js
```

For combined impact analysis, pass that built entry explicitly:

```powershell
npm exec -- code-impact analyze . src\utils\uploadFile.ts --function uploadFile --runtime --entry dist\server.js
```

Runtime evidence is helpful only if the run reaches the behavior you care about. Starting an API server alone may not exercise an upload function; if the service needs a request, database, environment settings, or other setup, arrange that safely before tracing. If there is no compatible Node entry point, continue with static analysis.

## Understanding the report

| Report label | Simple meaning |
| --- | --- |
| Target | The function or file being considered for change |
| Direct impact | Code that directly calls or depends on the target |
| Indirect impact | Code reached through one or more other dependents |
| Observed runtime impact | A relationship actually seen in the trace run |
| Possible dynamic impact | A relationship that may exist, but is not certain |
| Unknown relationship | Code the analyzer could not resolve, often due to dynamic behavior |
| Evidence | Whether a relationship came from source, runtime, or both |
| Confidence | How strongly the available evidence supports the relationship |
| Risk | A deterministic size/priority score, not a failure probability |

The main benefit is helping you decide what to inspect and test before changing code. Always review the listed evidence and uncertainty; this tool does not replace code review or application tests.

## When `npm ci` is used

For a fresh checkout of the application, `npm ci` installs exactly what is listed in its lockfile:

```powershell
npm ci
npm exec -- code-impact analyze .
```

Make sure the analyzer was installed and recorded in `package.json` and `package-lock.json` first. `npm ci` removes installed packages that are not recorded in the lockfile.

If npm prints an audit warning, inspect it separately:

```powershell
npm audit
```

Audit warnings concern packages in the application's dependency tree; they do not by themselves mean the analyzer command failed. Do not use `npm audit fix --force` without reviewing its potentially breaking changes.

## Tests for developers changing the analyzer itself

These commands are for the analyzer repository, not the application being analyzed. From the analyzer's own folder:

```powershell
npm ci
npm test
```

The tests cover JavaScript, TypeScript, JSX, imports, runtime tracing, graph merging, impact direction, CLI behavior, and timeouts. The repository also has a GitHub Actions workflow that tests supported operating systems and Node versions.

## More learning

- [README.md](./README.md) — package purpose, features, supported projects, API, and limitations.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — diagrams, module responsibilities, and guidance for developers extending the analyzer.
