// image cell の client 描画 (Issue #17)。icon (lucide SVG) / sparkline (履歴折れ線) を
// canvas に白黒で描き、PNG bytes にして返す。gray4 (4bit) 変換は Even Hub ホスト側の責務
// (SDK の ImageRawDataUpdateResult.imageToGray4Failed が示す通り) なので client は行わない。
// canvas/Image はブラウザ専用 — 純粋な形状計算 (sparklinePoints) を分離して bun test で固定する。
import {
  Battery,
  Clock,
  Cloud,
  Cpu,
  Heart,
  House,
  Moon,
  Sun,
  Thermometer,
  Zap,
} from 'lucide-static'
import type { GlassIconName } from './glass-types'
import type { HistorySample } from './history'

export type ImageCellSpec =
  | { source: 'icon'; icon: GlassIconName }
  | { source: 'sparkline'; segKey: string }

const ICON_SVGS: Record<GlassIconName, string> = {
  battery: Battery,
  clock: Clock,
  cpu: Cpu,
  thermometer: Thermometer,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  zap: Zap,
  heart: Heart,
  home: House,
}

export function glassIconSvg(name: GlassIconName): string {
  return ICON_SVGS[name]
}

// sparkline の折れ線点列 (px 座標)。値域を [pad, h-pad] に正規化し、x は等間隔。
// サンプル 0 件は空、1 件は中央の水平線 (2 点)。値域が平坦なら中央線。純粋関数。
export function sparklinePoints(
  samples: HistorySample[],
  w: number,
  h: number,
  pad = 3,
): [number, number][] {
  if (!samples.length) return []
  const innerH = h - 2 * pad
  const vs = samples.map((s) => s.v)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const span = max - min
  const yOf = (v: number): number =>
    span === 0 ? h / 2 : pad + (1 - (v - min) / span) * innerH
  if (samples.length === 1) {
    const y = yOf(vs[0] ?? 0)
    return [
      [pad, y],
      [w - pad, y],
    ]
  }
  const step = (w - 2 * pad) / (samples.length - 1)
  return samples.map((s, i) => [pad + i * step, yOf(s.v)])
}

// canvas を白黒 (黒地 + 白描画) で用意する。ブラウザ専用。
function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = '#fff'
  g.fillStyle = '#fff'
  return { canvas, g }
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}

// lucide SVG を白 stroke で描画する (currentColor を白へ固定)。
async function drawIcon(g: CanvasRenderingContext2D, name: GlassIconName, w: number, h: number): Promise<boolean> {
  const svg = ICON_SVGS[name].replace(/currentColor/g, '#fff')
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
  if (!ok) return false
  // 余白 2px を残して中央へ最大サイズで描く (アスペクト維持)。
  const size = Math.min(w, h) - 4
  g.drawImage(img, (w - size) / 2, (h - size) / 2, size, size)
  return true
}

function drawSparkline(g: CanvasRenderingContext2D, samples: HistorySample[], w: number, h: number): void {
  const pts = sparklinePoints(samples, w, h)
  if (!pts.length) return
  g.lineWidth = 2
  g.beginPath()
  for (const [i, [x, y]] of pts.entries()) {
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()
}

// image cell を PNG bytes に描画する。ブラウザ以外 / 描画不能は null (送信スキップ)。
export async function renderImageCell(
  spec: ImageCellSpec,
  w: number,
  h: number,
  samples: HistorySample[] = [],
): Promise<Uint8Array | null> {
  const c = makeCanvas(w, h)
  if (!c) return null
  if (spec.source === 'icon') {
    const ok = await drawIcon(c.g, spec.icon, w, h)
    if (!ok) return null
  } else {
    drawSparkline(c.g, samples, w, h)
  }
  return canvasToPngBytes(c.canvas)
}
