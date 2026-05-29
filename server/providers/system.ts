// システム状態 provider (CPU / メモリ / バッテリー / ディスク)。
// 旧 macSystemProvider の vm_stat/pmset/df/loadavg 直叩きを systeminformation で置換し、
// macOS 専用コマンドを廃して macOS / Linux / Windows 共通で動かす。
import * as si from 'systeminformation'
import type { Group, ProviderCtx, Segment } from '../types.ts'

// OD-1: クロスプラットフォームになったため group id は 'mac' でなく 'system'。
// 旧 'mac' から変えた点は SYSTEM_GROUP_ID 定数 1 か所で吸収する。
export const SYSTEM_GROUP_ID = 'system'

// disk のルートマウントを大文字化して '/' / 'C:' / 'C:\' のいずれかでマッチする。
// si.fsSize() の mount は Windows で 'C:' と 'C:\\' の両表記がありうるため両方許容する。
function isRootMount(mount: string): boolean {
  const m = mount.toUpperCase()
  return mount === '/' || m === 'C:' || m === 'C:\\'
}

export async function systemProvider(_ctx: ProviderCtx): Promise<Group | null> {
  // NOTE: 旧実装の CPU は loadavg(直近1分の負荷平均)をコア数で割った値だった。
  // si.currentLoad() はサンプリング瞬間のリアルタイム使用率で意味が異なり、
  // 内部で 2 回サンプリングするため最大 ~1s のレイテンシがある (poll 10-60s では許容)。
  // Promise.allSettled で 1 つの計測失敗が他メトリックを巻き込まないように隔離する。
  const [loadResult, memResult, batteryResult, fsResult] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    si.battery(),
    si.fsSize(),
  ])

  const segments: Segment[] = []

  if (loadResult.status === 'fulfilled') {
    const cpu = Math.round(loadResult.value.currentLoad)
    segments.push({ id: 'cpu', label: 'CPU', value: `${cpu}%`, percent: cpu, defaultEnabled: true })
  }

  if (memResult.status === 'fulfilled') {
    const { used, total } = memResult.value
    if (total > 0) {
      const mem = Math.round((used / total) * 100)
      segments.push({
        id: 'mem',
        label: 'Mem',
        value: `${mem}%`,
        percent: mem,
        defaultEnabled: true,
      })
    }
  }

  if (batteryResult.status === 'fulfilled' && batteryResult.value.hasBattery) {
    const battery = batteryResult.value
    segments.push({
      id: 'battery',
      label: 'Bat',
      value: `${battery.percent}%${battery.isCharging ? '+' : ''}`,
      percent: battery.percent,
      defaultEnabled: false,
    })
  }

  if (fsResult.status === 'fulfilled') {
    const root = fsResult.value.find((fs) => isRootMount(fs.mount))
    if (root) {
      const freeGb = Math.round((root.available / 1024 ** 3) * 10) / 10
      const seg: Segment = { id: 'disk', label: 'Disk', value: `${freeGb}G`, defaultEnabled: false }
      // 使用率% (表示タイミング条件の metric 用)。NaN/Infinity は percent に乗せない。
      if (Number.isFinite(root.use)) seg.percent = Math.round(root.use)
      segments.push(seg)
    }
  }

  if (segments.length === 0) return null
  return { id: SYSTEM_GROUP_ID, label: 'System', segments }
}
