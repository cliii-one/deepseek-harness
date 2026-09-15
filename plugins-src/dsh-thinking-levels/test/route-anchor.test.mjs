// route 解析对拍测试:模拟官方 DOM(哈希类名不可作锚,以 aria/结构锚定),
// 验证 displayName ≠ route(带括号)与 displayName === route(整串)两种形态,
// 以及多 provider 卡共存时各卡各行取到各自正确的 route。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 官方结构的最小 DOM 桩(jsdom 不引入,手写最小实现)
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.value = ''
    this.textContent = ''
  }
  getAttribute(name) { return this.attributes.get(name) ?? '' }
  setAttribute(name, value) { this.attributes.set(name, value) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  // querySelectorAll:本测试只用 button[aria-label] 单一形态
  querySelectorAll(selector) {
    assert.equal(selector, 'button[aria-label]', '测试桩仅支持 button[aria-label]')
    return this.collect((el) => el.tagName === 'BUTTON' && el.attributes.has('aria-label'))
  }
  collect(pred) {
    const out = []
    const walk = (el) => { if (pred(el)) out.push(el); for (const c of el.children) walk(c) }
    walk(this)
    return out
  }
  closest(tagOrSelector) {
    // 本测试只用 closest('section') 单一形态
    let node = this
    while (node !== null) {
      if (node.tagName === 'SECTION') return node
      node = node.parentElement
    }
    return null
  }
}

// 从 client.js 提取 routeOf 做单元验证(不依赖浏览器)
function extractRouteOf() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('function routeOf(idInput)')
  assert.ok(begin >= 0, 'client.js 缺少 routeOf')
  // 花括号配平截取完整函数体
  let depth = 0
  let end = -1
  for (let i = begin; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > begin, 'routeOf 函数体截取失败')
  const body = source.slice(begin, end + 1)
  return new Function('return ' + body)()
}

test('routeOf: displayName≠route 取括号内 route id', () => {
  const routeOf = extractRouteOf()
  // 组装:li > (button[aria-label="编辑 诺兰 (nolan)"]) + section > input
  const li = new FakeElement('li')
  const btn = new FakeElement('button')
  btn.setAttribute('aria-label', '编辑 诺兰 (nolan)')
  const section = new FakeElement('section')
  const input = new FakeElement('input')
  li.appendChild(btn)
  li.appendChild(section)
  section.appendChild(input)
  // input.closest('section') 返回 section;card 从 section.parentElement 向上找 LI
  assert.equal(routeOf(input), 'nolan')
})

test('routeOf: displayName===route 取整串', () => {
  const routeOf = extractRouteOf()
  const li = new FakeElement('li')
  const btn = new FakeElement('button')
  btn.setAttribute('aria-label', '编辑 workbd')
  const section = new FakeElement('section')
  const input = new FakeElement('input')
  li.appendChild(btn)
  li.appendChild(section)
  section.appendChild(input)
  assert.equal(routeOf(input), 'workbd')
})

test('routeOf: 英文 locale Edit 前缀', () => {
  const routeOf = extractRouteOf()
  const li = new FakeElement('li')
  const btn = new FakeElement('button')
  btn.setAttribute('aria-label', 'Edit Hotpot (huoguo)')
  const section = new FakeElement('section')
  const input = new FakeElement('input')
  li.appendChild(btn)
  li.appendChild(section)
  section.appendChild(input)
  assert.equal(routeOf(input), 'huoguo')
})

test('routeOf: 无 section 或无编辑按钮返回 null', () => {
  const routeOf = extractRouteOf()
  const orphan = new FakeElement('input')
  assert.equal(routeOf(orphan), null)
  const li = new FakeElement('li')
  const section = new FakeElement('section')
  const input = new FakeElement('input')
  li.appendChild(section)
  section.appendChild(input)
  assert.equal(routeOf(input), null)
})

test('多卡并存:每张卡的行取到各自 route(5 家场景)', () => {
  const routeOf = extractRouteOf()
  const cases = [
    ['编辑 诺兰 (nolan)', 'nolan'],
    ['编辑 火锅 (huoguo)', 'huoguo'],
    ['编辑 白开水 (bks)', 'bks'],
    ['编辑 浮云 (fh)', 'fh'],
    ['编辑 workbd', 'workbd'],
  ]
  for (const [label, expected] of cases) {
    const li = new FakeElement('li')
    const btn = new FakeElement('button')
    btn.setAttribute('aria-label', label)
    const section = new FakeElement('section')
    const input = new FakeElement('input')
    li.appendChild(btn)
    li.appendChild(section)
    section.appendChild(input)
    assert.equal(routeOf(input), expected, label + ' 应解析为 ' + expected)
  }
})
