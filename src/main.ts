import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

// Phase 2 ②③④ で companion UI (Home / Machine Edit) と glass 描画 (設定駆動) を実装する。
// 現時点はスキャフォールド確認用の最小実装: glass にアプリ名を出すだけ。
async function main() {
  const bridge = await waitForEvenAppBridge()
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          paddingLength: 8,
          containerID: 1,
          containerName: 'main',
          content: 'eveng2-toolbar',
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

main()
