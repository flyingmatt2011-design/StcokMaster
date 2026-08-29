const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

function runProcess(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `Candidate validation exited with code ${code}`).trim()));
    });
  });
}

function buildCandidatePythonEnvironment(env, candidateRoot) {
  const next = { ...(env || process.env) };
  const root = path.resolve(candidateRoot);
  const existing = String(next.PYTHONPATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => path.resolve(entry) !== root);
  next.PYTHONPATH = [root, ...existing].join(path.delimiter);
  return next;
}

async function validatePythonCandidate({ candidateRoot, changedPaths, pythonPath, env = process.env, run = runProcess }) {
  const root = path.resolve(candidateRoot);
  const candidateEnv = buildCandidatePythonEnvironment(env, root);
  const pythonFiles = (changedPaths || [])
    .filter((file) => typeof file === 'string' && file.toLowerCase().endsWith('.py'))
    .map((file) => path.resolve(root, ...file.replaceAll('\\', '/').split('/')));
  for (const file of pythonFiles) {
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Candidate Python path escapes runtime');
    await fs.access(file);
  }
  if (pythonFiles.length) {
    await run(pythonPath, ['-X', 'utf8', '-m', 'py_compile', ...pythonFiles], { cwd: root, env: candidateEnv });
  }
  const templateFiles = (changedPaths || [])
    .filter((file) => typeof file === 'string')
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.startsWith('templates/') && file.toLowerCase().endsWith('.j2'));
  const templateNames = [];
  for (const file of templateFiles) {
    const templatePath = path.resolve(root, ...file.split('/'));
    const relative = path.relative(root, templatePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Candidate template path escapes runtime');
    await fs.access(templatePath);
    templateNames.push(file.slice('templates/'.length));
  }
  if (templateNames.length) {
    await run(
      pythonPath,
      [
        '-X',
        'utf8',
        '-c',
        [
          'import json, os, sys',
          'from jinja2 import Environment, FileSystemLoader',
          'env = Environment(loader=FileSystemLoader(os.path.join(os.getcwd(), "templates")))',
          '[env.get_template(name) for name in json.loads(sys.argv[1])]',
        ].join('; '),
        JSON.stringify(templateNames),
      ],
      { cwd: root, env: candidateEnv },
    );
  }
  await fs.access(path.join(root, 'main.py'));
  await fs.access(path.join(root, 'server.py'));
  await run(
    pythonPath,
    [
      '-X',
      'utf8',
      '-c',
      'import os, sys; sys.path.insert(0, os.getcwd()); import server; assert getattr(server, "app", None) is not None',
    ],
    { cwd: root, env: candidateEnv },
  );
  await run(
    pythonPath,
    [
      '-X',
      'utf8',
      '-c',
      [
        'import os, sys',
        'sys.path.insert(0, os.getcwd())',
        'from src.storage import DatabaseManager',
        'db = DatabaseManager(db_url="sqlite:///:memory:")',
        'assert db is not None',
        'DatabaseManager.reset_instance()',
      ].join('; '),
    ],
    { cwd: root, env: candidateEnv },
  );
  return { ok: true, checkedPythonFiles: pythonFiles.length };
}

module.exports = { validatePythonCandidate, runProcess, buildCandidatePythonEnvironment };
