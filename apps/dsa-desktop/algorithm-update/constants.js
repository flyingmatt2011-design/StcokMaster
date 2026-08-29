const DEFAULT_POLICY = Object.freeze({
  eligibleRoots: ['src/', 'data_provider/', 'strategies/', 'api/', 'templates/'],
  eligibleFiles: ['server.py', 'main.py'],
  dependencyFiles: ['pyproject.toml', 'requirements.txt', 'requirements.lock', 'poetry.lock'],
  uiRoots: ['apps/dsa-web/', 'apps/dsa-desktop/'],
  ignoredRoots: ['docs/', 'tests/', 'artifacts/'],
  blockedExtensions: ['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1'],
});

module.exports = { DEFAULT_POLICY };
