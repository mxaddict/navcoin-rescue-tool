import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.join(import.meta.dirname, '..');
const projectTmpDir = path.join(projectRoot, 'tmp');

export async function makeProjectTempDir(prefix) {
  await fs.mkdir(projectTmpDir, { recursive: true });
  return fs.mkdtemp(path.join(projectTmpDir, `${prefix}-`));
}

export function getProjectRoot() {
  return projectRoot;
}
