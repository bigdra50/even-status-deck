// companion の hand-rolled HTML 断片を組み立てる共有 helper。
// data-action 付き要素 (button/select) と <option> 列の組み立てを一点集約し、
// esc() の適用漏れ (escape し忘れ / 二重 escape) を構造的に防ぐ。
// 出力はすべて plain string。DOM/companion 状態には依存しない (companion/index.ts は import しない)。
import { esc } from '../escape'

// 属性値マップ → ` key="esc(value)"` 列。値が undefined/false の属性は出さない。
// true は値無し属性 (例 disabled) として `key` のみ出す。
export type AttrValue = string | number | boolean | undefined
export function attrsHtml(attrs: Record<string, AttrValue>): string {
  return Object.entries(attrs)
    .map(([k, v]) => {
      if (v === undefined || v === false) return ''
      if (v === true) return k
      return `${k}="${esc(String(v))}"`
    })
    .filter(Boolean)
    .map((s) => ` ${s}`)
    .join('')
}

export type ActionElOpts = {
  cls?: string
  attrs?: Record<string, AttrValue>
  title?: string
  ariaLabel?: string
  disabled?: boolean
  // 呼び出し側で組み立て済みの追加属性 (例 `data-key="..." data-seg="..."`)。
  // 既に esc() 適用済みの前提でそのまま埋め込む (二重 escape を避ける)。
  extra?: string
}

// 属性の並び順は既存マークアップ (`class` → `data-action` → 呼び出し側 extra → title/aria-label/disabled →
// attrs) に合わせる。extra は呼び出し側で組み立て済み (esc 適用済み) の生文字列をそのまま挟む。
function actionElAttrs(action: string, opts: ActionElOpts): string {
  const { cls, attrs, title, ariaLabel, disabled, extra } = opts
  const head = attrsHtml({ class: cls, 'data-action': action })
  const tail = attrsHtml({ ...attrs, title, 'aria-label': ariaLabel, disabled })
  return extra ? `${head} ${extra}${tail}` : `${head}${tail}`
}

// data-action 付き <button>。content は組み立て済み HTML (esc は呼び出し側で適用済みの前提)。
export function actionButton(action: string, content: string, opts: ActionElOpts = {}): string {
  return `<button${actionElAttrs(action, opts)}>${content}</button>`
}

export type SelectOption = { value: string; label: string; selected?: boolean }

// <option> 列。value/label は esc() を適用する (呼び出し側で二重 escape しない)。
export function optionsHtml(options: SelectOption[]): string {
  return options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('')
}

// data-action 付き <select>。options は optionsHtml と同じ形。
export function actionSelect(
  action: string,
  options: SelectOption[],
  opts: ActionElOpts = {},
): string {
  return `<select${actionElAttrs(action, opts)}>${optionsHtml(options)}</select>`
}
