import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  GripVertical,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-static'

// companion (スマホ WebView) の UI アイコン。lucide-static の SVG 文字列を
// innerHTML 構築にそのまま埋め込む。stroke="currentColor" なので親の color を継承する。
export type IconName =
  | 'settings'
  | 'grip'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'align-top'
  | 'align-bottom'
  | 'check'
  | 'x'
  | 'loader'
  | 'arrow-left'
  | 'plus'
  | 'external-link'
  | 'alert'
  | 'tag'
  | 'pencil'
  | 'copy'
  | 'trash'
  | 'sparkles'
  | 'layout'
  | 'maximize'

const SVGS: Record<IconName, string> = {
  settings: Settings,
  grip: GripVertical,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'align-top': ArrowUpToLine,
  'align-bottom': ArrowDownToLine,
  check: Check,
  x: X,
  loader: LoaderCircle,
  'arrow-left': ArrowLeft,
  plus: Plus,
  'external-link': ExternalLink,
  alert: TriangleAlert,
  tag: Tag,
  pencil: Pencil,
  copy: Copy,
  trash: Trash2,
  sparkles: Sparkles,
  layout: LayoutGrid,
  maximize: Maximize2,
}

type IconOpts = { size?: number; stroke?: number; cls?: string }

// lucide の SVG 文字列の width/height/stroke-width/class を上書きして返す。
export function icon(name: IconName, opts: IconOpts = {}): string {
  const { size = 18, stroke, cls } = opts
  let svg = SVGS[name]
    .replace(/\bwidth="\d+"/, `width="${size}"`)
    .replace(/\bheight="\d+"/, `height="${size}"`)
    .replace(/class="[^"]*"/, `class="ic${cls ? ` ${cls}` : ''}"`)
  if (stroke != null) svg = svg.replace(/stroke-width="[\d.]+"/, `stroke-width="${stroke}"`)
  return svg
}
