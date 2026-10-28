import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'msal', test: /node_modules[\\/]@azure[\\/]msal/ },
            { name: 'react', test: /node_modules[\\/]react(?:-dom)?[\\/]/, priority: 2 },
          ],
        },
      },
    },
  },
})
