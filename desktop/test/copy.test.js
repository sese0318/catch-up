'use strict'
// User-facing English in the Windows app follows the writing rules in src/lib/copy-rules.ts.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const nodeModule = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { before, test } = require('node:test')
const { DESKTOP_HOTKEY_PRESETS } = require('../contract')
const { DESKTOP_DIR, createFakeElectron, loadWithElectron } = require('./helpers/fake-electron')

const COPY_RULES = path.resolve(DESKTOP_DIR, '..', 'src', 'lib', 'copy-rules.ts')
const README = path.join(DESKTOP_DIR, 'README.md')
const OFFLINE = path.join(DESKTOP_DIR, 'offline.html')
const NEVER_SAY = /\b(invisible|stealth|undetectable)\b/i

let copyRuleProblems = null
let skipReason = 'src/lib/copy-rules.ts is not next to desktop/'

async function importTypeScript (file) {
  const source = fs.readFileSync(file, 'utf8')
  if (typeof nodeModule.stripTypeScriptTypes === 'function') {
    const js = nodeModule.stripTypeScriptTypes(source)
    return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  }
  return import(pathToFileURL(file).href)
}

before(async () => {
  if (!fs.existsSync(COPY_RULES)) return
  try {
    ;({ copyRuleProblems } = await importTypeScript(COPY_RULES))
  } catch (error) {
    skipReason = 'could not load src/lib/copy-rules.ts (' + error.message + ')'
  }
})

function problemsIn (items) {
  return items
    .map((item) => ({ ...item, problems: copyRuleProblems(item.text) }))
    .filter((item) => item.problems.length > 0)
}

function readmeLines () {
  const lines = []
  let inFence = false
  fs.readFileSync(README, 'utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (/^```/.test(text)) {
        inFence = !inFence
        return
      }
      if (inFence || !text.trim() || /^\|(\s*-+\s*\|)+\s*$/.test(text)) return
      lines.push({ where: 'README.md line ' + (index + 1), text })
    })
  return lines
}

function offlineTexts () {
  const html = fs.readFileSync(OFFLINE, 'utf8')
  const visible = html.slice(html.indexOf('<body>'), html.indexOf('<script>'))
  const texts = [...visible.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean)
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
  const reasons = /const REASONS = \{([\s\S]*?)\n\s*\}/.exec(script)[1]
  texts.push(...[...reasons.matchAll(/'([^']+)'/g)].map((m) => m[1]))
  texts.push(/'(no address)'/.exec(script)[1])
  return texts.map((text) => ({ where: 'offline.html', text }))
}

function mainTexts () {
  const fake = createFakeElectron()
  const { COPY } = loadWithElectron('main.js', fake.electron)
  fake.cleanup()
  const texts = [COPY.badUrl, COPY.hotkeyNoneFree()]
  for (const wanted of DESKTOP_HOTKEY_PRESETS) {
    texts.push(COPY.hotkeyTakenNone(wanted), COPY.tray.hotkey(wanted))
    for (const other of DESKTOP_HOTKEY_PRESETS) {
      if (other === wanted) continue
      texts.push(COPY.hotkeyFallback(wanted, other), COPY.hotkeyTakenKept(wanted, other))
    }
  }
  texts.push(COPY.tray.hotkey(null))
  for (const value of Object.values(COPY.tray)) if (typeof value === 'string') texts.push(value)
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'))
  texts.push(pkg.description)
  return texts.map((text) => ({ where: 'main.js', text }))
}

test('the README follows the writing rules', (t) => {
  if (!copyRuleProblems) return t.skip(skipReason)
  assert.deepEqual(problemsIn(readmeLines()), [])
})

test('the offline page follows the writing rules', (t) => {
  if (!copyRuleProblems) return t.skip(skipReason)
  const texts = offlineTexts()
  assert.ok(texts.some((item) => item.text === "Can't reach Catch Up"))
  assert.ok(texts.some((item) => item.text === 'Retry'))
  assert.deepEqual(problemsIn(texts), [])
})

test('tray labels, hotkey notes and errors follow the writing rules', (t) => {
  if (!copyRuleProblems) return t.skip(skipReason)
  assert.deepEqual(problemsIn(mainTexts()), [])
})

test('no copy promises to hide the app', () => {
  const sources = [fs.readFileSync(README, 'utf8'), fs.readFileSync(OFFLINE, 'utf8'), ...mainTexts().map((item) => item.text)]
  for (const source of sources) assert.ok(!NEVER_SAY.test(source), source.slice(0, 60))
})

test('the offline page script hash matches its Content Security Policy', () => {
  const html = fs.readFileSync(OFFLINE, 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\r\n?/g, '\n')
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64')
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), 'update the script hash in offline.html to sha256-' + hash)
  assert.ok(csp.includes("default-src 'none'"))
  assert.equal((html.match(/<script/g) || []).length, 1)
  assert.ok(!/\s(src|href)=/i.test(html), 'the offline page loads nothing from outside')
  assert.ok(html.startsWith('<!doctype html>\n<html lang="en">'))
})
