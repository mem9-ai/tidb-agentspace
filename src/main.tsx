import { createRoot } from 'react-dom/client';
import App from './App';
import { WorkspaceThemeProvider } from './features/theme/WorkspaceThemeProvider';
import '@tidbcloud/uikit/style.css';
import './theme.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <WorkspaceThemeProvider>
    <App />
  </WorkspaceThemeProvider>,
);
