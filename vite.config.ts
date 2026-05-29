import { defineConfig } from 'vite'
import { devApiPlugin } from './server/vite-plugin.ts'

// provider 群 + dev API middleware は server/ へ切り出した (standalone と共有)。
// ここは Vite dev に server/vite-plugin の middleware を挿すだけ。
export default defineConfig({
  server: { host: true },
  plugins: [devApiPlugin()],
})
