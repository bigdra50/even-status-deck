// bridge コンテナ書込の applied-state 同期 (Issue #17)。
// 設計 (gpt-5.5 と合意):
//   - 送信 await が true を返した後にのみ applied state を更新する。false / 例外は
//     state を invalidate し、次回 apply を rebuild に倒す (送信前更新だと失敗時に再同期不能)。
//   - topology (幾何/様式/順序。content は含まない) が同一で差分 1 セルのみなら
//     textContainerUpgrade (BLE cheap path)。差分 2 セル以上は rebuild
//     (セル別 upgrade の逐次送信中に混在表示が見えるのを避ける)。
//   - image cell の実体 (PNG bytes) は container 作成では送れない (SDK 仕様: 起動時/再構築時は
//     placeholder)。rebuild / seed 後に dataKey 差分のあるものだけ直列に送信する。
// 呼び出しの直列化 (busy/pending) は glass.ts の refresh が担う。
import type { CompiledCell } from './glass-layout'
import type { CompiledImageCell } from './glass-render'

export type UpgradeTarget = { containerID: number; containerName: string; content: string }

// 同期対象の image (dataKey = 実体の版。sparkline の履歴更新などで変わると再送する)。
export type SyncImage = CompiledImageCell & { dataKey: string }

// glass.ts が bridge 呼び出しを注入する。例外は投げず false を返すこと。
// sendImage は bytes 描画 (canvas) 込み — 直列に await される (SDK: 画像の並行送信禁止)。
export type ContainerOps = {
  rebuild(cells: CompiledCell[], images: CompiledImageCell[]): Promise<boolean>
  upgrade(target: UpgradeTarget): Promise<boolean>
  sendImage(img: CompiledImageCell): Promise<boolean>
}

// content / 画像実体を除いた幾何/様式/順序の正規化キー。これが変わったら rebuild。
export function topoKey(cells: CompiledCell[], images: CompiledImageCell[] = []): string {
  const t = cells
    .map((c) =>
      [
        c.containerID,
        c.containerName,
        c.xPosition,
        c.yPosition,
        c.width,
        c.height,
        c.borderWidth,
        c.borderColor,
        c.borderRadius ?? 0,
        c.paddingLength,
        c.isEventCapture,
      ].join(','),
    )
    .join(';')
  const im = images
    .map((i) =>
      [i.containerID, i.containerName, i.xPosition, i.yPosition, i.width, i.height].join(','),
    )
    .join(';')
  return im ? `${t}|img:${im}` : t
}

export type ContainerSync = {
  // 直近の適用済み state を破棄する (overlay が別コンテナ集合を送った後などに呼ぶ)。
  invalidate(): void
  // 呼び出し元が送信済みのコンテナ集合を applied として記録する (起動ページ作成後に使う)。
  // 画像実体は起動時に送れないため未送信扱い (次の apply で送る)。
  seed(cells: CompiledCell[], images?: SyncImage[]): void
  // 目標のコンテナ集合へ同期する (差分なし=無送信 / text 1 セル=upgrade / それ以外=rebuild)。
  apply(cells: CompiledCell[], images?: SyncImage[]): Promise<void>
}

export function createContainerSync(ops: ContainerOps): ContainerSync {
  let topo: string | null = null
  let applied = new Map<string, string>() // containerName -> 送信済み content
  let appliedImages = new Map<string, string>() // containerName -> 送信済み dataKey

  function record(cells: CompiledCell[], images: SyncImage[]): void {
    topo = topoKey(cells, images)
    applied = new Map(cells.map((c) => [c.containerName, c.content]))
    appliedImages = new Map() // 実体は未送信 (rebuild/起動直後は placeholder)
  }
  function invalidate(): void {
    topo = null
    applied.clear()
    appliedImages.clear()
  }
  async function upgradeOne(cell: CompiledCell): Promise<void> {
    const ok = await ops.upgrade({
      containerID: cell.containerID,
      containerName: cell.containerName,
      content: cell.content,
    })
    if (ok) applied.set(cell.containerName, cell.content)
    else invalidate()
  }
  // dataKey が変わった image を直列に送る。失敗で invalidate (次回 rebuild で全再送)。
  async function syncImages(images: SyncImage[]): Promise<void> {
    for (const img of images) {
      if (appliedImages.get(img.containerName) === img.dataKey) continue
      const ok = await ops.sendImage(img)
      if (!ok) {
        invalidate()
        return
      }
      appliedImages.set(img.containerName, img.dataKey)
    }
  }

  return {
    invalidate,
    seed: (cells, images = []) => record(cells, images),
    async apply(cells: CompiledCell[], images: SyncImage[] = []): Promise<void> {
      if (topoKey(cells, images) === topo) {
        const changed = cells.filter((c) => applied.get(c.containerName) !== c.content)
        if (changed.length <= 1) {
          if (changed.length === 1 && changed[0]) await upgradeOne(changed[0])
          if (topo !== null) await syncImages(images) // upgrade 失敗 (invalidate 済) なら送らない
          return
        }
      }
      const ok = await ops.rebuild(cells, images)
      if (!ok) {
        invalidate()
        return
      }
      record(cells, images)
      await syncImages(images)
    },
  }
}
