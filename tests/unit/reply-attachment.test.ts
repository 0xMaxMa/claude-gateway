import { extractRepliedAttachment } from '../../mcp/tools/telegram/reply-attachment'

// The replied-to message is a full Telegram Message; we only care about the
// attachment fields here, so cast minimal literals.
const asMsg = (m: Record<string, unknown>) => m as any

describe('extractRepliedAttachment', () => {
  it('lifts a document (the CSV-quote-reply bug)', () => {
    const att = extractRepliedAttachment(
      asMsg({ document: { file_id: 'BQAC-doc', file_size: 1234, mime_type: 'text/csv', file_name: 'keys.csv' } }),
    )
    expect(att).toEqual({ kind: 'document', file_id: 'BQAC-doc', size: 1234, mime: 'text/csv', name: 'keys.csv' })
  })

  it('sanitizes a hostile file name', () => {
    const att = extractRepliedAttachment(asMsg({ document: { file_id: 'x', file_name: 'a<b>[c]\nd;e' } }))
    expect(att?.name).toBe('a_b__c__d_e')
  })

  it('lifts video / audio / voice / video_note / sticker', () => {
    expect(extractRepliedAttachment(asMsg({ video: { file_id: 'v' } }))?.kind).toBe('video')
    expect(extractRepliedAttachment(asMsg({ audio: { file_id: 'a' } }))?.kind).toBe('audio')
    expect(extractRepliedAttachment(asMsg({ voice: { file_id: 'vo' } }))?.kind).toBe('voice')
    expect(extractRepliedAttachment(asMsg({ video_note: { file_id: 'vn' } }))?.kind).toBe('video_note')
    expect(extractRepliedAttachment(asMsg({ sticker: { file_id: 's' } }))?.kind).toBe('sticker')
  })

  it('returns undefined for a photo (handled as image_path), plain text, and nothing', () => {
    expect(extractRepliedAttachment(asMsg({ photo: [{ file_id: 'p' }] }))).toBeUndefined()
    expect(extractRepliedAttachment(asMsg({ text: 'hello' }))).toBeUndefined()
    expect(extractRepliedAttachment(undefined)).toBeUndefined()
  })
})
