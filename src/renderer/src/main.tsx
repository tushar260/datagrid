import { createRoot } from 'react-dom/client'
import '@fontsource/google-sans/latin-400.css'
import '@fontsource/google-sans/latin-500.css'
import '@fontsource/google-sans/latin-600.css'
import '@fontsource/google-sans/latin-700.css'
import '@fontsource/google-sans-code/latin-400.css'
import '@fontsource/google-sans-code/latin-500.css'
import App from './App'
import './styles.css'
import { installTooltips } from './Tooltip'
import { initSettings } from './lib/settings'
import { initObjectCache } from './lib/objectCache'

initSettings()
installTooltips()
initObjectCache() // main-process invalidations + the ⌘O name index from the persistent cache
createRoot(document.getElementById('root')!).render(<App />)
