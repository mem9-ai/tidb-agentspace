import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, readThemePreference } from './features/theme/theme-preference';
import './theme.css';
import './styles.css';

applyTheme(readThemePreference());
createRoot(document.getElementById('root')!).render(<App />);
