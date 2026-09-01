const STOCKMASTER_STRONG_REQUIREMENT_PATHS = Object.freeze([
  'api/v1/endpoints/analysis.py',
  'api/v1/endpoints/history.py',
  'api/v1/schemas/history.py',
  'api/v1/schemas/system_config.py',
  'data_provider/base.py',
  'data_provider/provider_daily_cache.py',
  'src/analyzer.py',
  'src/config.py',
  'src/core/config_registry.py',
  'src/core/config_registry_categories.py',
  'src/core/pipeline.py',
  'src/services/analysis_service.py',
  'src/services/history_service.py',
  'src/services/kronos_forecast_service.py',
  'src/vendor/__init__.py',
  'src/vendor/kronos/__init__.py',
  'src/vendor/kronos/kronos.py',
  'src/vendor/kronos/module.py',
  'src/vendor/kronos/LICENSE',
  'src/vendor/kronos/UPSTREAM.md',
]);

const DEFAULT_POLICY = Object.freeze({
  eligibleRoots: ['src/', 'data_provider/', 'strategies/', 'api/', 'templates/'],
  eligibleFiles: ['server.py', 'main.py'],
  dependencyFiles: ['pyproject.toml', 'requirements.txt', 'requirements.lock', 'poetry.lock'],
  uiRoots: ['apps/dsa-web/', 'apps/dsa-desktop/'],
  ignoredRoots: ['docs/', 'tests/', 'artifacts/'],
  blockedExtensions: ['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1'],
  mergeStrategy: 'three-way-local-wins',
  conflictResolution: 'stockmaster-file-wins',
  strongRequirementPaths: STOCKMASTER_STRONG_REQUIREMENT_PATHS,
});

module.exports = { DEFAULT_POLICY, STOCKMASTER_STRONG_REQUIREMENT_PATHS };
