// Utilities for safely merging Codex's session_index.jsonl across devices.

/**
 * Merge two session indexes by session id.
 *
 * Newer records replace older records as a whole so removed fields do not
 * reappear. Equal or invalid timestamps use canonical JSON as a stable
 * tie-breaker, making the result independent of which device is local.
 *
 * @param {Buffer|string|null|undefined} localData
 * @param {Buffer|string|null|undefined} remoteData
 * @returns {Buffer|null} null only when neither side has an index file
 */
export function mergeSessionIndexBuffers(localData, remoteData) {
  if (localData == null && remoteData == null) return null;

  const records = new Map();
  for (const data of [localData, remoteData]) {
    for (const { entry, line } of parseSessionIndex(data)) {
      const previous = records.get(entry.id);
      records.set(entry.id, previous ? chooseRecord(previous, { entry, line }) : { entry, line });
    }
  }

  const merged = [...records.values()].map(({ entry }) => entry);
  merged.sort((a, b) => {
    const aTime = timestamp(a.updated_at);
    const bTime = timestamp(b.updated_at);
    if (aTime !== bTime) return bTime - aTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const text = merged.map((entry) => canonicalJson(entry)).join('\n');
  return Buffer.from(text ? `${text}\n` : '', 'utf8');
}

function parseSessionIndex(data) {
  if (data == null) return [];
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const entries = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Invalid session_index.jsonl at line ${index + 1}: malformed JSON`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error(`Invalid session_index.jsonl at line ${index + 1}: expected an object with a string id`);
    }
    entries.push({ entry, line: index + 1 });
  }
  return entries;
}

function chooseRecord(a, b) {
  const aTime = timestamp(a.entry.updated_at);
  const bTime = timestamp(b.entry.updated_at);
  if (aTime !== bTime) return bTime > aTime ? b : a;

  const aCanonical = canonicalJson(a.entry);
  const bCanonical = canonicalJson(b.entry);
  return bCanonical > aCanonical ? b : a;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function canonicalJson(value) {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}
