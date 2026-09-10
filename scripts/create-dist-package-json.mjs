import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a `dist/package.json` file with `"type": "module"` to enable
 * ES module resolution in the built output directory.
 *
 * @param {string} [rootDir] - The root directory where `dist/` will be created.
 *                             Defaults to `process.cwd()` if not provided.
 */
export function createDistPackageJson(rootDir = process.cwd()) {
	const distDir = join(rootDir, 'dist');

	mkdirSync(distDir, { recursive: true });

	writeFileSync(join(distDir, 'package.json'), '{"type":"module"}');
}

// Allow running directly: `node scripts/create-dist-package-json.mjs`
createDistPackageJson();
