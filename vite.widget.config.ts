import { defineConfig } from 'vite'

/**
 * The home-screen widget (src/widget/flowdeskWidget.ts) as one plain script,
 * served beside the app at /widget/flowdesk-widget.js for Scriptable to
 * download. Built after the app, into the app's own output.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/widget',
    emptyOutDir: false,
    target: 'es2019',
    minify: true,
    lib: {
      entry: 'src/widget/flowdeskWidget.ts',
      formats: ['iife'],
      name: 'FlowDeskWidget',
      fileName: () => 'flowdesk-widget.js',
    },
  },
})
