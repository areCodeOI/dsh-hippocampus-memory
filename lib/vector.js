/**
 * Vector helpers: FP32 storage, cosine similarity and 4×16-bit SimHash bands
 * for approximate nearest-neighbour candidate lookup in SQLite.
 */

export function normalizeVector(input) {
  const vector = input instanceof Float32Array ? input : Float32Array.from(input)
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (!norm) return { vector, norm: 0 }
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  return { vector, norm: 1 }
}

export function cosine(a, b, normA = 1, normB = 1) {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i]
  const denominator = (normA || 1) * (normB || 1)
  return denominator ? dot / denominator : 0
}

export function vectorToBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function vectorFromBlob(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return new Float32Array(copy.buffer)
}

function signFor(seed, band, bit, dimension) {
  let hash = (dimension * 374761393 + band * 668265263 + bit * 2246822519 + seed) >>> 0
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0
  hash = (hash ^ (hash >>> 16)) >>> 0
  return hash & 1 ? 1 : -1
}

/**
 * Deterministic 4-band, 16-bit SimHash signature.
 * @param {Float32Array} vector normalized vector
 * @param {{ bands?: number, bits?: number, seed?: number }} [options]
 * @returns {number[]}
 */
export function bandKeys(vector, { bands = 4, bits = 16, seed = 0x9e3779b9 } = {}) {
  const keys = new Array(bands).fill(0)
  for (let band = 0; band < bands; band += 1) {
    let key = 0
    for (let bit = 0; bit < bits; bit += 1) {
      let dot = 0
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        dot += vector[dimension] * signFor(seed, band, bit, dimension)
      }
      if (dot >= 0) key |= 1 << bit
    }
    keys[band] = key >>> 0
  }
  return keys
}
