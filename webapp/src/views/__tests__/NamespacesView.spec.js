import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import NamespacesView from '../NamespacesView.vue'

const apiMock = vi.fn()
vi.mock('../../lib', () => ({
  api: (...args) => apiMock(...args),
  ago: () => '刚刚',
}))

describe('NamespacesView', () => {
  it('renders namespace counts, policy tags and description', async () => {
    apiMock.mockResolvedValueOnce({
      default: 'default',
      namespaces: [
        {
          name: 'project-a',
          description: 'A project',
          total: 2,
          active: 2,
          conflict: 0,
          archived: 0,
          pendingDelete: 0,
          reserved: false,
          readOnly: true,
          autoRecall: false,
          retentionDays: 30,
          byKind: { persona: 0, semantic: 2, episodic: 0, buffer: 0 },
          lastAt: Date.now(),
        },
      ],
    })
    const wrapper = mount(NamespacesView, {
      props: { refreshKey: 0, auth: { role: 'admin' }, namespace: 'default' },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('project-a')
    expect(text).toContain('A project')
    expect(text).toContain('只读')
    expect(text).toContain('不自动召回')
    expect(text).toContain('保留 30 天')
    expect(text).toContain('人格 0')
  })
})
