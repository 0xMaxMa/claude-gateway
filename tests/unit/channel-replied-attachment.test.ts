import { AgentRunner } from '../../src/agent/runner'

// buildChannelXml is a private static; poke it directly to assert the wire tag.
const build = (meta: Record<string, string>): string =>
  (AgentRunner as any).buildChannelXml({ content: 'hi', meta })

describe('buildChannelXml — replied attachment', () => {
  it('surfaces replied_attachment_file_id (+ kind/mime/name) inside <replied>', () => {
    const xml = build({
      source: 'telegram',
      chat_id: '1',
      message_id: '10',
      user: 'jisack',
      replied_message_id: '5',
      replied_user: 'jisack',
      replied_attachment_file_id: 'BQAC-doc',
      replied_attachment_kind: 'document',
      replied_attachment_mime: 'text/csv',
      replied_attachment_name: 'keys.csv',
    })
    expect(xml).toContain('<replied message_id="5"')
    expect(xml).toContain('replied_attachment_file_id="BQAC-doc"')
    expect(xml).toContain('replied_attachment_name="keys.csv"')
  })

  it('omits replied attachment attrs when the quoted message had none', () => {
    const xml = build({
      chat_id: '1',
      message_id: '10',
      user: 'jisack',
      replied_message_id: '5',
      replied_user: 'jisack',
      replied_text: 'just text',
    })
    expect(xml).toContain('<replied message_id="5"')
    expect(xml).not.toContain('replied_attachment_file_id')
  })
})
