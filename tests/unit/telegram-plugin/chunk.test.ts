/**
 * Unit tests for chunk() pure function from mcp/gateway/tools/telegram/pure.ts
 */
import { chunk, MAX_CHUNK_LIMIT } from '../../../mcp/gateway/tools/telegram/pure'

describe('chunk()', () => {
  test('text <= limit → returns single element array', () => {
    const text = 'Hello, world!'
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('empty string returns single empty element', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('text exactly at limit → returns single element', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('text > limit, mode=length → splits at char count boundary', () => {
    const text = 'a'.repeat(150)
    const result = chunk(text, 100, 'length')
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(100)
    expect(result[1]).toHaveLength(50)
  })

  test('text > limit, mode=newline → prefers double-newline (paragraph)', () => {
    // Build a text where para boundary is well past limit/2
    const part1 = 'a'.repeat(60)
    const part2 = 'b'.repeat(60)
    const text = part1 + '\n\n' + part2
    // limit = 80: para is at 60, which is > 40 (limit/2), so should split there
    const result = chunk(text, 80, 'newline')
    expect(result[0]).toBe(part1)
    // Leading newlines stripped
    expect(result[1]).toBe(part2)
  })

  test('text > limit, mode=newline → falls back to single newline', () => {
    const part1 = 'a'.repeat(60)
    const part2 = 'b'.repeat(60)
    const text = part1 + '\n' + part2
    // limit=80, single newline at 60 > 40, no double-newline found, uses single
    const result = chunk(text, 80, 'newline')
    expect(result[0]).toBe(part1)
    expect(result[1]).toBe(part2)
  })

  test('text > limit, mode=newline → falls back to space', () => {
    // No newlines, but has space
    const part1 = 'hello world this is a test of the chunking'
    // 42 chars, limit 30
    const result = chunk(part1, 30, 'newline')
    // Space at some position > 15 (limit/2)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const r of result) {
      expect(r.length).toBeLessThanOrEqual(30)
    }
  })

  test('text > limit, mode=newline → hard cut if no whitespace found', () => {
    // No spaces or newlines
    const text = 'a'.repeat(150)
    const result = chunk(text, 100, 'newline')
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(100)
    expect(result[1]).toHaveLength(50)
  })

  test('chunk limit is capped semantically at MAX_CHUNK_LIMIT (4096)', () => {
    expect(MAX_CHUNK_LIMIT).toBe(4096)
    const text = 'x'.repeat(5000)
    const result = chunk(text, MAX_CHUNK_LIMIT, 'length')
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(4096)
    expect(result[1]).toHaveLength(904)
  })

  test('leading newlines stripped from subsequent chunks', () => {
    const text = 'a'.repeat(60) + '\n\n' + '\n\n' + 'b'.repeat(60)
    const result = chunk(text, 80, 'newline')
    // The rest after cut has leading newlines stripped
    expect(result[result.length - 1]).not.toMatch(/^\n/)
  })

  test('multiple splits — all chunks within limit', () => {
    const text = 'hello '.repeat(1000) // 6000 chars
    const limit = 100
    const result = chunk(text, limit, 'length')
    for (const r of result) {
      expect(r.length).toBeLessThanOrEqual(limit)
    }
    // Verify no content lost (newlines are stripped so we compare join)
    expect(result.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  test('mode=length splits at exact char count with no padding', () => {
    const text = 'abcdefghij'.repeat(10) // 100 chars
    const result = chunk(text, 30, 'length')
    expect(result[0]).toBe('a'.repeat(0) + text.slice(0, 30))
    expect(result[0]).toHaveLength(30)
  })
})
