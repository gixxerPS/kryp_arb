const fs = require('node:fs');
const path = require('node:path');

function loadExistingOutput(outPath) {
  if (!fs.existsSync(outPath)) {
    return {
      meta: {},
      symbols: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    return {
      meta: parsed && typeof parsed.meta === 'object' && parsed.meta ? parsed.meta : {},
      symbols: parsed && typeof parsed.symbols === 'object' && parsed.symbols ? parsed.symbols : {},
    };
  } catch (err) {
    console.log(`[symbolinfo] could not parse existing file ${outPath}: ${String(err?.message ?? err)}`);
    return {
      meta: {},
      symbols: {},
    };
  }
}

function mergeAndWriteOutput(outPath, nextOut) {
  const existing = loadExistingOutput(outPath);
  const mergedSymbols = {
    ...existing.symbols,
    ...nextOut.symbols,
  };
  const sortedSymbols = Object.fromEntries(
    Object.entries(mergedSymbols).sort(([a], [b]) => a.localeCompare(b))
  );

  const merged = {
    meta: {
      ...existing.meta,
      ...nextOut.meta,
    },
    symbols: sortedSymbols,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');

  return merged;
}

module.exports = {
  loadExistingOutput,
  mergeAndWriteOutput,
};
