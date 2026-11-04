import '@tidbcloud/uikit/style.css';
import './theme.css';
import './features/analytics/discovery.css';
import {
  analyticsDisabled,
  capture,
  capturePage,
  setAnalyticsDisabled,
  startAnalytics,
} from './features/analytics/capture';
import { configureApi } from './api/client';

async function start() {
  const base = document.body.dataset.base || '/';
  const page = document.body.dataset.page;
  try {
    const response = await fetch(base + 'config.json', { cache: 'no-store' });
    if (response.ok) {
      const config: unknown = await response.json();
      configureApi(config);
      await startAnalytics();
    }
  } catch {
    /* Public content remains usable without optional measurement. */
  }
  if (page === 'home' || page === 'get_started' || page === 'sales_guide' || page === 'api_docs') {
    capturePage(page);
    document
      .querySelector('[data-analytics="try"]')
      ?.addEventListener('click', () => capture({ name: 'try_clicked', page }));
  }
  const button = document.getElementById('analytics-choice');
  const status = document.getElementById('analytics-choice-status');
  const update = () => {
    if (button)
      button.textContent = analyticsDisabled()
        ? 'Enable optional analytics'
        : 'Turn optional analytics off';
    if (status)
      status.textContent = analyticsDisabled()
        ? 'Optional browser analytics is off.'
        : 'Optional session-only browser analytics is on.';
  };
  button?.addEventListener('click', () => {
    void setAnalyticsDisabled(!analyticsDisabled()).then(update);
  });
  update();
}
void start();
