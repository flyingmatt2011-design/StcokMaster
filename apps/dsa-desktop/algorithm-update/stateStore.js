const fs = require('node:fs/promises');
const path = require('node:path');

function createStateStore(filePath, defaults = {}) {
  async function read() {
    try {
      const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...defaults };
      try { await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`); } catch { /* best effort quarantine */ }
      return { ...defaults };
    }
  }

  async function write(value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  }

  return { read, write };
}

module.exports = { createStateStore };
