// bridge コンテナ書込の applied-state 同期 (Issue #17)。
// 設計 (gpt-5.5 と合意):
//   - 送信 await が true を返した後にのみ applied state を更新する。false / 例外は
//     state を invalidate し、次回 apply を rebuild に倒す (送信前更新だと失敗時に再同期不能)。
//   - topology (幾何/様式/順序。content は含まない) が同一で差分 1 セルのみなら
//     textContainerUpgrade (BLE cheap path)。差分 2 セル以上は rebuild
//     (セル別 upgrade の逐次送信中に混在表示が見えるのを避ける)。
// 呼び出しの直列化 (busy/pending) は glass.ts の refresh が担う。
import type { CompiledCell } from './glass-layout'

export type UpgradeTarget = { containerID: number; containerName: string; content: string }

// glass.ts が bridge 呼び出しを注入する。例外は投げず false を返すこと。
export type ContainerOps = {
  rebuild(cells: CompiledCell[]): Promise<boolean>
  upgrade(target: UpgradeTarget): Promise<boolean>
}

// content を除いた幾何/様式/順序の正規化キー。これが変わったら rebuild。
export function topoKey(cells: CompiledCell[]): string {
  return cells
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
}

export type ContainerSync = {
  // 直近の適用済み state を破棄する (overlay が別コンテナ集合を送った後などに呼ぶ)。
  invalidate(): void
  // 呼び出し元が送信済みのコンテナ集合を applied として記録する (起動ページ作成後に使う)。
  seed(cells: CompiledCell[]): void
  // 目標のコンテナ集合へ同期する (差分なし=送信なし / 1 セル=upgrade / それ以外=rebuild)。
  apply(cells: CompiledCell[]): Promise<void>
}

export function createContainerSync(ops: ContainerOps): ContainerSync {
  let topo: string | null = null
  let applied = new Map<string, string>() // containerName -> 送信済み content

  function record(cells: CompiledCell[]): void {
    topo = topoKey(cells)
    applied = new Map(cells.map((c) => [c.containerName, c.content]))
  }
  function invalidate(): void {
    topo = null
    applied.clear()
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

  return {
    invalidate,
    seed: record,
    async apply(cells: CompiledCell[]): Promise<void> {
      if (topoKey(cells) === topo) {
        const changed = cells.filter((c) => applied.get(c.containerName) !== c.content)
        if (changed.length === 0) return
        if (changed.length === 1 && changed[0]) return upgradeOne(changed[0])
      }
      const ok = await ops.rebuild(cells)
      if (ok) record(cells)
      else invalidate()
    },
  }
}
