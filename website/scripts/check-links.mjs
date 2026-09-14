import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, '.vitepress/dist')
const base = process.env.DOCS_BASE || '/'
assert(base.startsWith('/') && base.endsWith('/'), 'DOCS_BASE must start and end with /')
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.filter(e => !['node_modules', '.vitepress'].includes(e.name)).map(e =>
    e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]))
  return groups.flat()
}
const htmlFiles = (await files(output)).filter(file => file.endsWith('.html'))
assert(htmlFiles.length > 1, 'Build the website before checking links')
const documents = new Map(await Promise.all(htmlFiles.map(async file => [file, await readFile(file, 'utf8')])) )
const errors = []
let checked = 0
for (const [file, html] of documents) {
  const current = new URL(base + relative(output, file), 'https://docs.invalid')
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const raw = match[1].replaceAll('&amp;', '&')
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue
    const url = new URL(raw, current)
    if (!url.pathname.startsWith(base)) {
      errors.push(`${relative(output, file)}: outside configured base: ${raw}`)
      continue
    }
    let target = resolve(output, decodeURIComponent(url.pathname.slice(base.length)))
    if (target !== output && !target.startsWith(output + '/')) {
      errors.push(`${file}: path escapes output: ${raw}`)
      continue
    }
    try {
      if ((await stat(target)).isDirectory()) target = join(target, 'index.html')
      await stat(target)
    } catch {
      errors.push(`${relative(output, file)}: missing target: ${raw}`)
      continue
    }
    if (url.hash && target.endsWith('.html')) {
      const fragment = decodeURIComponent(url.hash.slice(1))
      const targetHtml = documents.get(target) || await readFile(target, 'utf8')
      const ids = new Set([...targetHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
      if (!ids.has(fragment)) errors.push(`${relative(output, file)}: missing anchor: ${raw}`)
    }
    checked++
  }
}

// Validate executable JSON syntax, then compare configuration examples with source defaults.
const template = JSON.parse(await readFile(join(root, '../config.template.json'), 'utf8'))
let examples = 0
function checkSubset(value, source, path = '') {
  for (const [key, item] of Object.entries(value)) {
    assert(Object.hasOwn(source, key), `Unknown template field ${path}${key}`)
    assert.equal(typeof item, typeof source[key], `Wrong type for ${path}${key}`)
    if (item && typeof item === 'object' && !Array.isArray(item)) checkSubset(item, source[key], `${path}${key}.`)
  }
}
for (const file of (await files(root)).filter(file => file.endsWith('.md'))) {
  const markdown = await readFile(file, 'utf8')
  for (const [, snippet] of markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    const value = JSON.parse(snippet)
    if (file.endsWith('/reference/configuration.md')) checkSubset(value, template)
    examples++
  }
}
assert(examples > 0, 'Expected at least one JSON configuration example')
assert.equal(errors.length, 0, errors.join('\n'))
console.log(`Checked ${htmlFiles.length} HTML pages, ${checked} internal links/assets/fragments, and ${examples} JSON example(s).`)
