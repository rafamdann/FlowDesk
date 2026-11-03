import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Older than Vite's default, so a cheap Android phone whose browser has
    // not updated in a while still gets code it can run. The default assumes
    // browsers from late 2022 on; a Galaxy A03 can ship with older than that.
    target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'],
  },
})
