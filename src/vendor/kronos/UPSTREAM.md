# Kronos vendor provenance

- Upstream repository: <https://github.com/shiyu-coder/Kronos>
- Pinned revision: `67b630e67f6a18c9e9be918d9b4337c960db1e9a`
- Imported files: `model/kronos.py`, `model/module.py`
- License: MIT, preserved in `LICENSE`

StockMaster only changes the package import in `kronos.py` from the upstream
top-level `model.module` path to the local relative `.module` path. The model
architecture and inference implementation remain otherwise unchanged.
