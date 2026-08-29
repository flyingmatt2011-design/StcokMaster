const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildCandidatePythonEnvironment,
  validatePythonCandidate,
} = require('../algorithm-update/validator');

test('candidate validation explicitly exposes the candidate root to Python imports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-validator-'));
  await fs.writeFile(path.join(root, 'main.py'), 'VALUE = 1\n', 'utf8');
  await fs.writeFile(path.join(root, 'server.py'), 'app = object()\n', 'utf8');
  const calls = [];

  await validatePythonCandidate({
    candidateRoot: root,
    changedPaths: ['server.py'],
    pythonPath: 'python-test',
    env: { PYTHONPATH: path.join(root, 'existing'), PYTHONSAFEPATH: '1' },
    run: async (command, args, options) => { calls.push({ command, args, options }); },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.cwd, path.resolve(root));
  assert.equal(calls[1].options.env.PYTHONPATH.split(path.delimiter)[0], path.resolve(root));
  assert.match(calls[1].args.at(-1), /sys\.path\.insert\(0, os\.getcwd\(\)\)/);
  assert.match(calls[1].args.at(-1), /import server/);
  assert.match(calls[2].args.at(-1), /DatabaseManager\(db_url="sqlite:\/\/\/:memory:"\)/);
});

test('candidate Python environment keeps existing search paths after the runtime root', () => {
  const root = path.resolve('candidate-runtime');
  const existing = [path.resolve('first-lib'), path.resolve('second-lib')].join(path.delimiter);
  const result = buildCandidatePythonEnvironment({ PYTHONPATH: existing }, root);
  assert.deepEqual(result.PYTHONPATH.split(path.delimiter), [root, ...existing.split(path.delimiter)]);
});

test('candidate validation compiles changed Jinja report templates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-validator-template-'));
  await fs.mkdir(path.join(root, 'templates'), { recursive: true });
  await fs.writeFile(path.join(root, 'main.py'), 'VALUE = 1\n', 'utf8');
  await fs.writeFile(path.join(root, 'server.py'), 'app = object()\n', 'utf8');
  await fs.writeFile(path.join(root, 'templates', 'report_markdown.j2'), '{{ value }}\n', 'utf8');
  const calls = [];

  await validatePythonCandidate({
    candidateRoot: root,
    changedPaths: ['templates/report_markdown.j2'],
    pythonPath: 'python-test',
    run: async (command, args, options) => { calls.push({ command, args, options }); },
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].args.at(-2), /Environment/);
  assert.deepEqual(JSON.parse(calls[0].args.at(-1)), ['report_markdown.j2']);
  assert.equal(calls[0].options.cwd, path.resolve(root));
});
