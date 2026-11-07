import assert from 'node:assert/strict'
import test from 'node:test'
import { vectorWeightFromEnv } from '../lib/scoring.js'

test('scoring: HIPPOCAMPUS_VECTOR_WEIGHT=0 disables blending instead of being replaced', () => {
  assert.equal(vectorWeightFromEnv({}), 0.35)
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: '' }), 0.35)
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: '0' }), 0)
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: '0.6' }), 0.6)
  // Clamp and ignore garbage.
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: '5' }), 1)
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: '-1' }), 0)
  assert.equal(vectorWeightFromEnv({ HIPPOCAMPUS_VECTOR_WEIGHT: 'abc' }), 0.35)
})
