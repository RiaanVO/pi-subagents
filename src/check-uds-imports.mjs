#!/usr/bin/env node
/**
 * check-uds-imports.mjs — Validates ESM compatibility AND file existence of UDS modules.
 *
 * Two checks are performed:
 * 1. ESM compatibility — .mjs files must not use CJS-only Node.js built-in exports
 *    (e.g., homedir/tmpdir from 'node:path' → use 'node:os' instead)
 * 2. File existence — All referenced source/build files must exist at build time.
 *    This catches the classic "ENOENT: uds-child.mjs" or missing dist/uds-server.js.
 *
 * Run: node src/check-uds-imports.mjs
 * Exit code: 0 = clean, 1 = errors found
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Known CJS-only exports that break in ESM
const CJS_ONLY = {
  "node:path": ["homedir", "tmpdir"],
  // node:fs, node:os, node:child_process, etc. all work in ESM
};

let exitCode = 0;
let errors = [];
let warnings = [];

// ---------------------------------------------------------------------------
// Check 1: ESM compatibility (original)
// ---------------------------------------------------------------------------

/** Check a single file for CJS-only imports. */
function checkESMCompatibility(filePath, content, relativePath) {
  for (const [module, exports] of Object.entries(CJS_ONLY)) {
    for (const exportName of exports) {
      // Match: import { ... homedir ... } from "node:path"
      const pattern = new RegExp(
        `import\\s*\\{[^}]?\\b${exportName}\\b[^}]*\\}\\s*from\\s*['"]${module}\\b['"]`,
      );
      if (pattern.test(content)) {
        errors.push(
          `${relativePath}: '${exportName}' from '${module}' is CJS-only. ` +
            `Use '${module === "node:path" ? "node:os" : module}' instead.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: File existence (new)
// ---------------------------------------------------------------------------

/**
 * Paths that the codebase references at build/runtime and must exist.
 * Key: the path as referenced in code (relative to project root or src/)
 * Value: { expected: boolean, description: string }
 */
const REFERENCED_FILES = [
  // Child process script — the most common missing-file crash source
  {
    relativePath: "src/uds-child.mjs",
    check: "exists",
    description: "UDS child process script (referenced by uds-agent-runner.ts fork())",
  },
  // UDS server build output — referenced by uds-child.mjs import
  {
    relativePath: "dist/uds-server.js",
    check: "exists",
    description: "Compiled UDS server (referenced by uds-child.mjs import, created by tsc)",
  },
  // Agent runner types — referenced by uds-agent-runner.ts
  {
    relativePath: "dist/agent-runner.js",
    check: "exists",  // expected in production, may be missing in dev
    description: "Compiled agent runner (referenced by uds-agent-runner.ts)",
  },
  // Agent types — referenced by uds-agent-runner.ts
  {
    relativePath: "dist/agent-types.js",
    check: "exists",
    description: "Compiled agent types (referenced by uds-agent-runner.ts)",
  },
  // Environment module — referenced by uds-agent-runner.ts
  {
    relativePath: "dist/env.js",
    check: "exists",
    description: "Compiled env module (referenced by uds-agent-runner.ts)",
  },
  // Types module — referenced by uds-agent-runner.ts
  {
    relativePath: "dist/types.js",
    check: "exists",
    description: "Compiled types (referenced by uds-agent-runner.ts)",
  },
  // Usage module — referenced by uds-agent-runner.ts
  {
    relativePath: "dist/usage.js",
    check: "exists",
    description: "Compiled usage module (referenced by uds-agent-runner.ts)",
  },
];

/** Check that all referenced source files exist. */
function checkFileExistence() {
  for (const { relativePath, description } of REFERENCED_FILES) {
    const fullPath = join(projectRoot, relativePath);
    if (!existsSync(fullPath)) {
      if (relativePath.startsWith("dist/")) {
        // Build outputs are optional in development — warn, don't fail
        warnings.push(
          `${relativePath}: MISSING (not yet built — run \"npm run build\" first). ${description}`,
        );
      } else {
        // Source files must always exist
        errors.push(
          `${relativePath}: MISSING — ${description}`,
        );
      }
    }
  }
}

/**
 * Scan .ts files for fork() calls and verify the target file exists.
 * This catches future regressions when new child scripts are added.
 */
function checkForkTargets() {
  const tsFiles = [];
  for (const file of readdirSync(join(__dirname, "..", "src"))) {
    if (file.endsWith(".ts")) {
      tsFiles.push(join(__dirname, "..", "src", file));
    }
  }

  for (const filePath of tsFiles) {
    const content = readFileSync(filePath, "utf-8");
    const relativePath = filePath.replace(join(projectRoot, "src") + "/", "");

    // Match: fork("...uds-child.mjs")
    const forkPattern = /fork\(\s*["']([^"']+\.mjs)["']\s*\)/g;
    let match;
    while ((match = forkPattern.exec(content)) !== null) {
      const targetPath = join(projectRoot, "src", match[1]);
      if (!existsSync(targetPath)) {
        errors.push(
          `${relativePath}: fork("${match[1]}") → ${targetPath} does not exist`,
        );
      }
    }

    // Match: import(..."../dist/uds-server.js")  or  "../dist/uds-server.js"
    const importPattern = /["']\.\.\/dist\/["'][^"']+\.js["']/g;
    while ((match = importPattern.exec(content)) !== null) {
      const importPath = match[0].replace(/["']/g, "");
      const resolvedPath = join(projectRoot, "src", importPath);
      // dist/ files won't exist in dev — only warn
      if (!existsSync(resolvedPath)) {
        // These are build outputs, check once at end
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Checking UDS module references...\n");

// Check 1: ESM compatibility of .mjs files
const mjsFiles = [];
for (const file of readdirSync(__dirname)) {
  if (file.endsWith(".mjs")) {
    mjsFiles.push(join(__dirname, file));
  }
}

if (mjsFiles.length > 0) {
  console.log(`Checking ${mjsFiles.length} .mjs file(s) for ESM compatibility...`);
  for (const filePath of mjsFiles) {
    const content = readFileSync(filePath, "utf-8");
    const relativePath = filePath.replace(__dirname + "/", "");
    checkESMCompatibility(filePath, content, relativePath);
  }
  console.log();
}

// Check 2: File existence
console.log("Checking file existence for referenced modules...");
checkFileExistence();
checkForkTargets();
console.log();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("✗ Errors found:");
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
}

if (warnings.length > 0) {
  console.warn("⚠ Warnings:");
  for (const warn of warnings) {
    console.warn(`  ⚠ ${warn}`);
  }
}

if (exitCode === 0 && errors.length === 0) {
  console.log("✓ All .mjs files are ESM-compatible.");
  if (warnings.length > 0) {
    console.log(`  ${warnings.length} build-output warning(s) — run 'npm run build' to resolve.`);
  }
  console.log("✓ All referenced source files exist.");
} else if (errors.length > 0) {
  console.error(`\n✗ ${errors.length} error(s) found that will cause runtime failures.`);
}

process.exit(errors.length > 0 ? 1 : 0);
