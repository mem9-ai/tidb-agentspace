import { createRoot } from 'react-dom/client';
import App from './App';
import { Admin } from './features/analytics/Admin';
import { AnalyticsPreference } from './features/analytics/AnalyticsPreference';
import { startAnalytics } from './features/analytics/capture';
import { WorkspaceThemeProvider } from './features/theme/WorkspaceThemeProvider';
import '@tidbcloud/uikit/style.css';
import './theme.css';
import './styles.css';
import { Alert, Button } from '@tidbcloud/uikit';
import { configureApi } from './api/client';

// Some hosted gateways preserve the redeemed OAuth callback query on the landing URL.
// It is not needed by the Console after the server callback completes.
const landing = new URL(window.location.href);
if (landing.searchParams.has('code') && landing.searchParams.has('state')) {
  landing.searchParams.delete('code');
  landing.searchParams.delete('state');
  window.history.replaceState(window.history.state, '', landing);
}

const root = createRoot(document.getElementById('root')!);
async function start() {
  try {
    const response = await fetch(import.meta.env.BASE_URL + 'config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load config.json.');
    const config: unknown = await response.json();
    configureApi(config);
    if (!window.location.pathname.replace(/\/$/, '').endsWith('/admin')) void startAnalytics();
    root.render(
      <WorkspaceThemeProvider>
        {window.location.pathname.replace(/\/$/, '').endsWith('/admin') ? (
          <Admin />
        ) : (
          <>
            <App />
            <AnalyticsPreference />
          </>
        )}
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
