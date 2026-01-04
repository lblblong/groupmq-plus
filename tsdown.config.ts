import { defineConfig } from 'tsdown'
import copy from 'rollup-plugin-copy'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  plugins: [
    copy({
      targets: [{ src: 'src/lua/**/*.lua', dest: 'dist/' }],
      flatten: false,
    }),
  ],
  onSuccess: 'yalc push',
})

