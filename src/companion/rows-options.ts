// 表示オプション (#36) の汎用レンダラ。group/segment の OptionField[] を select / toggle / number で
// 描く UI 断片。rows.ts から分離。esc/icons・config 型・./html だけに依存し、状態は持たない (純関数)。
import type { OptionValues } from '../config'
import { esc } from '../escape'
import type { OptionField, OptionScope } from '../options'
import { optionsHtml } from './html'

// select 型の表示オプション 1 フィールド。
function optionSelectControl(
  a: string,
  f: Extract<OptionField, { kind: 'select' }>,
  values: OptionValues,
): string {
  const cur = String(values[f.id] ?? f.default)
  const opts = optionsHtml(f.choices.map((c) => ({ ...c, selected: c.value === cur })))
  return `<label class="clock-fld">${esc(f.label)}<select class="format-select" ${a} data-field="${esc(f.id)}" data-kind="select">${opts}</select></label>`
}

// toggle 型の表示オプション 1 フィールド。
function optionToggleControl(
  a: string,
  f: Extract<OptionField, { kind: 'toggle' }>,
  values: OptionValues,
): string {
  const raw = values[f.id]
  const on = typeof raw === 'boolean' ? raw : f.default
  return `<label class="clock-fld">${esc(f.label)}<button class="tg sm ${on ? 'on' : ''}" ${a} data-field="${esc(f.id)}" data-kind="toggle" data-val="${on ? '0' : '1'}"></button></label>`
}

// number 型の表示オプション 1 フィールド。
function optionNumberControl(
  a: string,
  f: Extract<OptionField, { kind: 'number' }>,
  values: OptionValues,
): string {
  const cur = Number(values[f.id] ?? f.default)
  const step = f.step ? `step="${f.step}"` : ''
  return `<label class="clock-fld">${esc(f.label)}<input class="vis-num" type="number" min="${f.min}" max="${f.max}" ${step} ${a} data-field="${esc(f.id)}" data-kind="number" value="${cur}" />${f.unit ? esc(f.unit) : ''}</label>`
}

// 表示オプション 1 フィールド (kind 別ディスパッチ)。
function optionFieldControl(a: string, f: OptionField, values: OptionValues): string {
  if (f.kind === 'select') return optionSelectControl(a, f, values)
  if (f.kind === 'toggle') return optionToggleControl(a, f, values)
  return optionNumberControl(a, f, values)
}

// 表示オプションの汎用レンダラ (#36)。schema (OptionField[]) を select / toggle / number で描く。
// scope で segment/source を区別し、segId は segment scope のときのみ意味を持つ (source は空)。
// select / number は change イベント (onOptionChange)、toggle は click イベント (onClick の opt-set) で届く。
// clock の Time/Date/順序 もこのレンダラで描かれ、値解決/書込は options.ts が format に合成する。
export function optionControls(
  key: string,
  segId: string,
  scope: OptionScope,
  fields: OptionField[],
  values: OptionValues,
): string {
  if (!fields.length) return ''
  const a = `data-action="opt-set" data-key="${key}" data-seg="${esc(segId)}" data-scope="${scope}"`
  return `<div class="clock-ctl">${fields.map((f) => optionFieldControl(a, f, values)).join('')}</div>`
}
