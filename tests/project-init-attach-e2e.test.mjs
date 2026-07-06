import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleProjectCommand } from '../packages/cli/src/cli/project.js';

describe('project init and verify e2e', () => {
  it('project init and verify e2e with DI', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-e2e-'));
    const projectId = 'e2e-project';
    const stackId = 'e2e-stack';
    const SHELL_ROOT = process.cwd();

    // track exit codes without throwing
    let lastExit = null;
    const processExit = (code) => {
      lastExit = code;
      // do not throw
    };

    const initProjectFromStack = async () => ({ targetPath: tmpDir });
    const listTemplates = () => [{ stackId }];

    const bootstrapProject = async ({ projectRoot }) => {
      // create required fixtures
      fs.mkdirSync(path.join(projectRoot, 'routekit'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'routekit', 'project.json'), JSON.stringify({ id: projectId }, null, 2));
      fs.writeFileSync(path.join(projectRoot, 'routekit', 'kg.yaml'), 'k: v\n');
      fs.mkdirSync(path.join(projectRoot, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.vscode'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.vscode', 'mcp.json'),
        JSON.stringify({ servers: { local: { name: 'local' } } }, null, 2)
      );
      fs.mkdirSync(path.join(projectRoot, '.rks', 'rag'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.rks', 'rag', 'config.json'), JSON.stringify({ setting: true }, null, 2));
      return { vendor: 'stub' };
    };

    const verifyProjectRoot = (root, opts) => {
      const checks = [];
      const required = [
        path.join(root, 'routekit', 'project.json'),
        path.join(root, 'routekit', 'kg.yaml'),
        path.join(root, 'notes'),
        path.join(root, '.vscode', 'mcp.json'),
        path.join(root, '.rks', 'rag', 'config.json'),
      ];
      let ok = true;
      for (const p of required) {
        const exists = fs.existsSync(p);
        checks.push({ id: p, status: exists ? 'pass' : 'fail' });
        if (!exists) ok = false;
      }
      return { status: ok ? 'pass' : 'fail', projectId: opts?.projectId || projectId, projectRoot: root, checks };
    };

    const verifyById = ({ projectId: id }) => ({ status: 'pass', projectId: id, projectRoot: tmpDir, checks: [] });

    const deps = {
      processExit,
      initProjectFromStack,
      listTemplates,
      bootstrapProject,
      verifyProjectRoot,
      verifyById,
    };

    // Run init
    await handleProjectCommand({ sub: 'init', kv: { id: projectId, stack: stackId, path: tmpDir }, SHELL_ROOT, args: [] }, deps);
    expect(lastExit).toBe(0);

    // Verify fixtures exist
    expect(fs.existsSync(path.join(tmpDir, 'routekit', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'routekit', 'kg.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'notes'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.rks', 'rag', 'config.json'))).toBe(true);

    // Reset exit capture
    lastExit = null;

    // Run verify by id
    await handleProjectCommand({ sub: 'verify', kv: { id: projectId }, SHELL_ROOT, args: [] }, deps);
    expect(lastExit).toBe(0);

    // cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  });
});
