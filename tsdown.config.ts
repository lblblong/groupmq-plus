import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  copy: [{ from: 'src/lua', to: 'dist/lua' }],
  onSuccess: 'yalc push',
})

