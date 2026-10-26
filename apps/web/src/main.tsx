import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Nunito Sans (brand manual: complementary typeface), served with the app.
import '@fontsource-variable/nunito-sans/wght.css'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './pwa/serviceWorker.ts'
import { SessionProvider } from './session/SessionProvider.tsx'

// Installable PWA: one service worker, updates only on user confirmation.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
)
