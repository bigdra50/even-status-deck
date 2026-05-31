#!/usr/bin/env python3
# subprocess provider の例 (PROTOCOL §9c / README "provider を拡張する" (2))。
#
# 任意言語で書ける。標準出力に StatusDoc (または単一 Group) の JSON を 1 度 print して exit
# するだけ。server が毎 poll で実行し、parseStatusDoc でサニタイズして 1 ソースとして集約する。
#
# 使い方:
#   1. このファイルを ~/.config/status-deck/providers/weather.py に置く (任意の名前で可)。
#   2. ~/.config/status-deck/config.toml に command を明示登録する:
#        [providers.weather]
#        command = "python3"
#        args = ["${configDir}/providers/weather.py"]   # 絶対パス or ${configDir} のみ
#        timeoutMs = 1000
#        ttlMs = 30000
#
# 制約 (server 側で強制):
#   - args は ${configDir} 展開のみ・絶対パス必須 (~/$VAR は展開されない)。
#   - shell:false / timeout / 出力 512KB 上限。子プロセスの env は PATH のみ (token は渡らない)。
#   - 値の整形は provider 責務、描画は client 責務。token 等は出さず集計値だけ載せる。

import json
import sys


def build_group() -> dict:
    # ここで実データを取得する (API 呼び出し等)。失敗時は value="n/a" や state="error" を返す。
    temp_c = 21
    return {
        "id": "weather",
        "label": "Weather",
        "segments": [
            # label が空文字なら値のみ描画される。percent(0-100) があれば progress bar が出る。
            {"id": "temp", "label": "", "value": f"{temp_c}°", "defaultEnabled": True},
        ],
        # upstream が落ちているが応答はできるとき: "state": "error", "message": "..." を付ける (任意)。
    }


def main() -> int:
    # 単一 Group をそのまま出してよい (server が StatusDoc に包む)。
    json.dump(build_group(), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
