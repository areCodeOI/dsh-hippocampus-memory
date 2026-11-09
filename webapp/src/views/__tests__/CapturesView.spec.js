import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import CapturesView from '../CapturesView.vue'

const apiMock = vi.fn()
vi.mock('../../lib', () => ({
  api: (...args) => apiMock(...args),
  ago: () => '刚刚',
}))

describe('CapturesView', () => {
  it('renders pending auto-captured candidates with review role', async () => {
    apiMock.mockImplementation((route) => {
      if (route.startsWith('/api/captures')) {
        return Promise.resolve({
          items: [
            {
              id: 'mem_capture_1',
              content: '我的项目使用 PostgreSQL',
              namespace: 'default',
              importance: 6,
              tags: ['auto-capture'],
              createdAt: Date.now(),
              metadata: { autoCapture: { review: 'pending', role: 'user' } },
            },
          ],
          total: 1,
        })
      }
      return Promise.resolve({ namespaces: [] })
    })
    const wrapper = mount(CapturesView, {
      props: { refreshKey: 0, auth: { role: 'admin' } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('捕获审阅')
    expect(text).toContain('我的项目使用 PostgreSQL')
    expect(text).toContain('用户陈述')
    expect(text).toContain('auto-capture')
  })
})
