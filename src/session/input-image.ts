/** Native Claude stream-json image input; never a file-reading tool grant. */
export interface InputImage {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string };
}
