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
  LOCATION_SOURCE_ID,
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

// weather (client.weather) source 単位の表示オプション (#38 sunFormat / #40 単位・感度 / #39 降水)。
// 値の永続は SourceDef.options、型への解決は weather.ts(readWeatherOptions)。temp/wind は open-meteo の
// クエリ単位で正確に取り、pres は producer 内で hPa→inHg 換算。単位/感度を変えると optSig が変わり即再取得する。
const WEATHER_OPTION_FIELDS: OptionField[] = [
  {
    kind: 'select',
    id: 'tempUnit',
    label: 'Temp unit',
    choices: [
      { value: 'C', label: 'Celsius' },
      { value: 'F', label: 'Fahrenheit' },
    ],
    default: 'C',
  },
  {
    kind: 'select',
    id: 'windUnit',
    label: 'Wind unit',
    choices: [
      { value: 'kmh', label: 'km/h' },
      { value: 'ms', label: 'm/s' },
      { value: 'mph', label: 'mph' },
    ],
    default: 'kmh',
  },
  {
    kind: 'select',
    id: 'windDir',
    label: 'Wind dir',
    choices: [
      { value: 'text', label: 'Text (N/NE)' },
      { value: 'arrow', label: 'Arrow' },
    ],
    default: 'text',
  },
  {
    kind: 'select',
    id: 'presUnit',
    label: 'Pressure',
    choices: [
      { value: 'hPa', label: 'hPa' },
      { value: 'inHg', label: 'inHg' },
    ],
    default: 'hPa',
  },
  {
    kind: 'select',
    id: 'stormSensitivity',
    label: 'Storm alert',
    choices: [
      { value: 'low', label: 'Low (4hPa)' },
      { value: 'normal', label: 'Normal (3hPa)' },
      { value: 'high', label: 'High (2hPa)' },
    ],
    default: 'normal',
  },
  {
    kind: 'select',
    id: 'sunFormat',
    label: 'Sun clock',
    choices: [
      { value: 'auto', label: 'Auto (locale)' },
      { value: '24h', label: '24h (19:01)' },
      { value: '12h', label: '12h (7:01p)' },
    ],
    default: 'auto',
  },
  // #39 降水ナウキャスト。rainin の表示モード + 降水しきい値(mm)+ 取得粒度。
  {
    kind: 'select',
    id: 'rainMode',
    label: 'Rain shows',
    choices: [
      { value: 'nextrain', label: 'Next rain' },
      { value: '1hchance', label: '1h chance' },
      { value: 'recent', label: 'Recent mm' },
    ],
    default: 'nextrain',
  },
  {
    kind: 'number',
    id: 'rainThreshold',
    label: 'Rain threshold',
    min: 0,
    max: 5,
    step: 0.1,
    unit: 'mm',
    default: 0.1,
  },
  {
    kind: 'select',
    id: 'rainGranularity',
    label: 'Rain detail',
    choices: [
      { value: 'auto', label: 'Auto (15min)' },
      { value: 'hourly', label: 'Hourly' },
    ],
    default: 'auto',
  },
]

// source 単位オプションのスキーマ (sourceId → fields)。無ければ空配列。
// geoinfo (client.geoinfo) source 単位の表示オプション (#45)。標高の単位のみ(表示の純変換、URL に影響しない)。
const GEOINFO_OPTION_FIELDS: OptionField[] = [
  {
    kind: 'select',
    id: 'elevUnit',
    label: 'Altitude unit',
    choices: [
      { value: 'm', label: 'Meters' },
      { value: 'ft', label: 'Feet' },
    ],
    default: 'm',
  },
]

// airquality (client.airquality) source 単位の表示オプション (#41)。AQI 規格のみ(両値は同一レスポンス)。
const AIRQUALITY_OPTION_FIELDS: OptionField[] = [
  {
    kind: 'select',
    id: 'aqiStandard',
    label: 'AQI standard',
    choices: [
      { value: 'us', label: 'US AQI' },
      { value: 'eu', label: 'EU AQI' },
    ],
    default: 'us',
  },
]

// places (client.places) source 単位の表示オプション (#42)。距離単位と方位スタイル。
const PLACES_OPTION_FIELDS: OptionField[] = [
  {
    kind: 'select',
    id: 'distUnit',
    label: 'Distance unit',
    choices: [
      { value: 'km', label: 'km' },
      { value: 'mi', label: 'mi' },
    ],
    default: 'km',
  },
  {
    kind: 'select',
    id: 'bearingStyle',
    label: 'Bearing',
    choices: [
      { value: 'text', label: 'Text (N/NE)' },
      { value: 'compass16', label: '16-point (NNE)' },
      { value: 'arrow', label: 'Arrow' },
    ],
    default: 'text',
  },
]

// 統合 client source "Location" は 1 つの options バッグに 4 系統(weather/geoinfo/airquality/places)の
// field を持つ(field id は非衝突)。旧 5 source の schema を union して返す。
const LOCATION_OPTION_FIELDS: OptionField[] = [
  ...WEATHER_OPTION_FIELDS,
  ...GEOINFO_OPTION_FIELDS,
  ...AIRQUALITY_OPTION_FIELDS,
  ...PLACES_OPTION_FIELDS,
]

export function sourceOptionSchema(sourceId: string): OptionField[] {
  if (sourceId === LOCATION_SOURCE_ID) return LOCATION_OPTION_FIELDS
  return []
}

// 1 値を field の型へ正規化する (select は choices 検証、toggle は bool、number は clamp)。
// export は単体テスト用 (foundation の中核バリデーション。公開 schema が clock/空のみで API 経由到達不能なため)。
export function coerce(field: OptionField, raw: unknown): string | number | boolean {
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
// export は単体テスト用 (coerce と同じ理由)。
export function applyDefaults(fields: OptionField[], bag: OptionValues | undefined): OptionValues {
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
