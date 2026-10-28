import { createRoot } from 'react-dom/client';
import App from './App';
import { WorkspaceThemeProvider } from './features/theme/WorkspaceThemeProvider';
import '@tidbcloud/uikit/style.css';
import './theme.css';
import './styles.css';
import { Alert, Button } from '@tidbcloud/uikit';
import { configureApi } from './api/client';

const root = createRoot(document.getElementById('root')!);
async function start() {
  try {
    const response = await fetch(import.meta.env.BASE_URL + 'config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load config.json.');
    const config: unknown = await response.json();
    configureApi(config);
    root.render(
      <WorkspaceThemeProvider>
        <App />
      </WorkspaceThemeProvider>,
    );
  } catch (error) {
    root.render(
      <WorkspaceThemeProvider>
        <Alert color="red" title="Console configuration unavailable" m={24}>
          {error instanceof Error ? error.message : 'Unable to start the Console.'}
          <Button onClick={() => void start()} mt={16}>
            Retry
          </Button>
        </Alert>
      </WorkspaceThemeProvider>,
    );
  }
}
void start();
