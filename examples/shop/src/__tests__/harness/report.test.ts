import { describe, expect, it } from 'vitest'
import { composeImageTag } from './report.js'

describe('composeImageTag', () => {
  it('reads the pinned tag from infra/hatchet/compose.yaml when no env override is set', () => {
    const original = process.env['KYU_HATCHET_IMAGE_TAG']
    delete process.env['KYU_HATCHET_IMAGE_TAG']
    try {
      // Keep in step with infra/hatchet/compose.yaml's pinned default.
      expect(composeImageTag()).toBe('hatchet-lite:v0.107.0')
    } finally {
      if (original !== undefined) process.env['KYU_HATCHET_IMAGE_TAG'] = original
    }
  })

  it('prefers the env override over the compose file default', () => {
    const original = process.env['KYU_HATCHET_IMAGE_TAG']
    process.env['KYU_HATCHET_IMAGE_TAG'] = 'v9.9.9'
    try {
      expect(composeImageTag()).toBe('hatchet-lite:v9.9.9')
    } finally {
      if (original === undefined) delete process.env['KYU_HATCHET_IMAGE_TAG']
      else process.env['KYU_HATCHET_IMAGE_TAG'] = original
    }
  })
})
