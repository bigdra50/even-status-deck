// 表示オプション基盤 (#36)。source / segment が「単位・粒度・フォーマット」等の表示オプションを
// 宣言的に持ち、companion が汎用レンダラ (select / toggle / number) で描いて永続する横断基盤。
// 旧来 clock だけが持っていたフォーマット UI (companion の isClock 分岐) をこの基盤へ移す。
//
// 設計:
// - スキーマ (OptionField[]) はコード所有 (builtin/client は自前)。segmentOptionSchema / sourceOptionSchema で引く。
// - 値の永続は SegMeta.options / SourceDef.options (素材 = 全 profile 共有)。
// - clock (datetime) は後方互換のため値を options ではなく既存の SegMeta.format に合成して読み書きする
//   (resolveSegmentOptions / setSegmentOption の clock 分岐がアダプタ)。新 source は options バッグを使う。
import {
  CLOCK_DATE_OPTS,
  CLOCK_SEG,
  CLOCK_TIME_OPTS,
  composeClockFormat,
  defaultClockFormat,
  parseClockFormat,
} from './builtins'
import {
  BUILTIN_SOURCE_ID,
  type Config,
  type OptionValues,
  type SegMeta,
  sourceById,
} from './config'

// 1 オプションの宣言。companion はこれを見て select / toggle / number を描く。
export type OptionField =
  | {
      kind: 'select'
      id: string
      label: string
      choices: { value: string; label: string }[]
      default: string
    }
  | { kind: 'toggle'; id: string; label: string; default: boolean }
  | {
      kind: 'number'
      id: string
      label: string
      min: number
      max: number
      step?: number
      unit?: string
      default: number
    }

// オプションの所属先。segment 単位 (clock の format 等) と source 単位 (将来の weather 単位 等)。
export type OptionScope = 'segment' | 'source'

// clock (datetime) segment の表示フォーマットを Time / Date / Order の 3 select として宣言する。
// 値は SegMeta.options ではなく既存の SegMeta.format に合成して読み書きする (後方互換アダプタ)。
const CLOCK_OPTION_FIELDS: OptionField[] = [
  {
    kind: 'select',
    id: 'time',
    label: 'Time',
    choices: CLOCK_TIME_OPTS.map((o) => ({ value: o.format, label: o.label })),
    default: '',
  },
  {
    kind: 'select',
    id: 'date',
    label: 'Date',
    choices: CLOCK_DATE_OPTS.map((o) => ({ value: o.format, label: o.label })),
    default: '',
  },
  {
    kind: 'select',
    id: 'order',
    label: 'Order',
    choices: [
      { value: 'time', label: 'Time → Date' },
      { value: 'date', label: 'Date → Time' },
    ],
    default: 'time',
  },
]

function isClockDatetime(sourceId: string, groupId: string, segId: string): boolean {
  return sourceId === BUILTIN_SOURCE_ID && groupId === 'clock' && segId === CLOCK_SEG
}

function findSegMeta(
  cfg: Config,
  sourceId: string,
  groupId: string,
  segId: string,
): SegMeta | undefined {
  return cfg.groups[sourceId]?.[groupId]?.segments.find((s) => s.id === segId)
}

// segment 単位オプションのスキーマ (sourceId, groupId, segId → fields)。無ければ空配列。
export function segmentOptionSchema(
  sourceId: string,
  groupId: string,
  segId: string,
): OptionField[] {
  if (isClockDatetime(sourceId, groupId, segId)) return CLOCK_OPTION_FIELDS
  return []
}

// source 単位オプションのスキーマ (sourceId → fields)。無ければ空配列。
// 利用者は後続 issue (weather の単位 #40 等)。基盤としては解決/書込/再 fetch の経路だけ用意する。
export function sourceOptionSchema(_sourceId: string): OptionField[] {
  return []
}

// 1 値を field の型へ正規化する (select は choices 検証、toggle は bool、number は clamp)。
function coerce(field: OptionField, raw: unknown): string | number | boolean {
  if (field.kind === 'select') {
    const v = String(raw)
    return field.choices.some((c) => c.value === v) ? v : field.default
  }
  if (field.kind === 'toggle') {
    if (typeof raw === 'boolean') return raw
    return raw === 'true' || raw === '1' || raw === 1
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return field.default
  return Math.min(field.max, Math.max(field.min, n))
}

// バッグを default 込みで解決する (未設定/未知キーは field.default、不正値は coerce で矯正)。
function applyDefaults(fields: OptionField[], bag: OptionValues | undefined): OptionValues {
  const out: OptionValues = {}
  for (const f of fields) {
    const v = bag?.[f.id]
    out[f.id] = v === undefined ? f.default : coerce(f, v)
  }
  return out
}

// segment options を default 込みで解決する。clock は SegMeta.format から導出する (後方互換)。
export function resolveSegmentOptions(
  cfg: Config,
  sourceId: string,
  groupId: string,
  segId: string,
): OptionValues {
  const sm = findSegMeta(cfg, sourceId, groupId, segId)
  if (isClockDatetime(sourceId, groupId, segId)) {
    const cur = parseClockFormat(sm?.format ?? defaultClockFormat())
    return { time: cur.time, date: cur.date, order: cur.order }
  }
  return applyDefaults(segmentOptionSchema(sourceId, groupId, segId), sm?.options)
}

// source options を default 込みで解決する。
export function resolveSourceOptions(cfg: Config, sourceId: string): OptionValues {
  return applyDefaults(sourceOptionSchema(sourceId), sourceById(cfg, sourceId)?.options)
}

// segment オプション 1 値を cfg に書き込む (mutate)。clock は format を再合成する (後方互換)。
// 戻り値: 書き込めたら true (未知 field / segment 不在は false)。
export function setSegmentOption(
  cfg: Config,
  sourceId: string,
  groupId: string,
  segId: string,
  fieldId: string,
  raw: unknown,
): boolean {
  const sm = findSegMeta(cfg, sourceId, groupId, segId)
  if (!sm) return false
  if (isClockDatetime(sourceId, groupId, segId)) {
    const cur = parseClockFormat(sm.format ?? defaultClockFormat())
    if (fieldId === 'time') cur.time = String(raw)
    else if (fieldId === 'date') cur.date = String(raw)
    else if (fieldId === 'order') cur.order = raw === 'date' ? 'date' : 'time'
    else return false
    sm.format = composeClockFormat(cur.time, cur.date, cur.order) || undefined
    return true
  }
  const field = segmentOptionSchema(sourceId, groupId, segId).find((f) => f.id === fieldId)
  if (!field) return false
  sm.options = { ...(sm.options ?? {}), [fieldId]: coerce(field, raw) }
  return true
}

// source オプション 1 値を cfg に書き込む (mutate)。戻り値: 書き込めたら true。
export function setSourceOption(
  cfg: Config,
  sourceId: string,
  fieldId: string,
  raw: unknown,
): boolean {
  const field = sourceOptionSchema(sourceId).find((f) => f.id === fieldId)
  if (!field) return false
  const s = sourceById(cfg, sourceId)
  if (!s) return false
  s.options = { ...(s.options ?? {}), [fieldId]: coerce(field, raw) }
  return true
}
