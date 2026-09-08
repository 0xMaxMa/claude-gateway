import type { Message } from 'grammy/types'

/** Non-photo attachment metadata lifted off a message, mirroring the shape the
 * live-message handlers build for `attachment_*`. Photos are handled separately
 * (downloaded to an image_path); everything else is surfaced by file_id so the
 * agent can fetch it on demand via download_attachment. */
export type RepliedAttachment = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

/**
 * Extract a non-photo attachment from the message being replied to.
 *
 * A quote-reply carries the full replied-to message, including any document /
 * video / audio / voice / video_note / sticker it held — but the receiver only
 * ever downloaded a replied *photo*. So replying to (say) a CSV dropped the file
 * entirely: the agent saw `<replied>` with no way to reach the attachment. This
 * returns that attachment's metadata so the reply path can surface a
 * `replied_attachment_file_id` the agent can pass to download_attachment.
 *
 * Returns undefined when the replied message has no such attachment (plain text,
 * or a photo — which the caller handles as an image_path).
 */
export function extractRepliedAttachment(msg: Message | undefined): RepliedAttachment | undefined {
  if (!msg) return undefined
  if (msg.document)
    return {
      kind: 'document',
      file_id: msg.document.file_id,
      size: msg.document.file_size,
      mime: msg.document.mime_type,
      name: safeName(msg.document.file_name),
    }
  if (msg.video)
    return {
      kind: 'video',
      file_id: msg.video.file_id,
      size: msg.video.file_size,
      mime: msg.video.mime_type,
      name: safeName(msg.video.file_name),
    }
  if (msg.audio)
    return {
      kind: 'audio',
      file_id: msg.audio.file_id,
      size: msg.audio.file_size,
      mime: msg.audio.mime_type,
      name: safeName(msg.audio.file_name),
    }
  if (msg.voice)
    return {
      kind: 'voice',
      file_id: msg.voice.file_id,
      size: msg.voice.file_size,
      mime: msg.voice.mime_type,
    }
  if (msg.video_note)
    return {
      kind: 'video_note',
      file_id: msg.video_note.file_id,
      size: msg.video_note.file_size,
    }
  if (msg.sticker)
    return {
      kind: 'sticker',
      file_id: msg.sticker.file_id,
      size: msg.sticker.file_size,
    }
  return undefined
}
