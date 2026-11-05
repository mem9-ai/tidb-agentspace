import { capture } from '../analytics/capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Text } from '@tidbcloud/uikit';
import { workspaceApi, type FileAnalysisResult } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { WorkspaceQueryResults } from '../../ui/WorkspaceQueryResults';
import { fileHash } from '../files/file-location';
import {
  formatSales,
  salesByProductSql,
  salesByStateSql,
  salesReport,
  salesTotals,
} from './sales-insights';

const reportPath = '/my-us-sales-report.md';
type ReportStatus = 'checking' | 'absent' | 'saved' | 'existing' | 'unknown' | 'unavailable';

export function SalesSelfService({
  resourceId,
  path,
  fileVersion,
  canAnalyze,
  onFileChanged,
  active,
}: {
  resourceId: string;
  path: string;
  fileVersion: string | null;
  canAnalyze: boolean;
  onFileChanged: () => void;
  active: boolean;
}) {
  const [feedback, setFeedback] = useState(false);
  const [states, setStates] = useState<FileAnalysisResult | null>(null);
  const [products, setProducts] = useState<FileAnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<ReportStatus>('checking');
  const [focusNext, setFocusNext] = useState(false);
  const running = useRef<AbortController | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const stateTotals = salesTotals(states, 'state');
  const productTotals = salesTotals(products, 'product');
  const topState = stateTotals?.[0];
  const topProduct = productTotals?.[0];

  useEffect(() => () => running.current?.abort(), []);
  const checkReport = useCallback(async () => {
    try {
      const value = await workspaceApi.fileMetadata(resourceId, reportPath);
      setReport((current) =>
        value.data.type === 'file' ? (current === 'saved' ? 'saved' : 'existing') : 'unavailable',
      );
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.status === 404) setReport('absent');
      else setReport('unavailable');
    }
  }, [resourceId]);
  useEffect(() => {
    if (active) void checkReport();
  }, [active, checkReport]);
  useEffect(() => {
    if (!focusNext || !active || busy || saving) return;
    const next = actions.current?.querySelector<HTMLElement>('[data-next-step]');
    if (next && !next.hasAttribute('disabled')) {
      const box = next.getBoundingClientRect();
      if (box.top < 96 || box.bottom > window.innerHeight - 24)
        next.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      next.focus({ preventScroll: true });
      setFocusNext(false);
    }
  }, [active, busy, focusNext, products, report, saving, states]);

  async function analyze(kind: 'states' | 'products') {
    if (running.current || !canAnalyze || (kind === 'products' && !topState)) return;
    const trigger = document.activeElement;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError('');
    if (kind === 'states') {
      setStates(null);
      setProducts(null);
    } else setProducts(null);
    try {
      const before = await workspaceApi.fileMetadata(resourceId, path, controller.signal);
      if (before.data.type !== 'file' || before.data.version !== fileVersion) {
        onFileChanged();
        setError('The file changed before analysis. Open it to review the saved data.');
        return;
      }
      const sql = kind === 'states' ? salesByStateSql : salesByProductSql(topState!.label);
      const value = await workspaceApi.analyzeFile(
        { resourceId, path, engine: 'duckdb', sql },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const after = await workspaceApi.fileMetadata(resourceId, path, controller.signal);
      if (controller.signal.aborted) return;
      if (after.data.type !== 'file' || after.data.version !== fileVersion) {
        onFileChanged();
        setError('The file changed during analysis. Open it to review the saved data.');
      } else if (
        value.engine !== 'duckdb' ||
        !salesTotals(value, kind === 'states' ? 'state' : 'product')
      ) {
        setError('The analysis did not return usable sales data. Open the sample to review it.');
      } else {
        if (kind === 'states') setStates(value);
        else setProducts(value);
        if (document.activeElement === trigger || document.activeElement === document.body)
          setFocusNext(true);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : 'Could not analyze the sample. Try again.',
        );
    } finally {
      if (running.current === controller) running.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function saveReport() {
    if (!stateTotals || !productTotals || !canAnalyze || saving || report !== 'absent') return;
    const trigger = document.activeElement;
    setSaving(true);
    setError('');
    let writeStarted = false;
    try {
      const current = await workspaceApi.fileMetadata(resourceId, path);
      if (current.data.type !== 'file' || current.data.version !== fileVersion) {
        onFileChanged();
        setError('The sample changed. Review it before saving a report.');
        return;
      }
      writeStarted = true;
      await workspaceApi.saveReport({
        resourceId,
        path: reportPath,
        type: 'file',
        content: salesReport(path, stateTotals, productTotals),
      });
      setReport('saved');
      if (document.activeElement === trigger || document.activeElement === document.body)
        setFocusNext(true);
    } catch (cause) {
      if (!writeStarted) setError('Could not check the sample. Try again before saving.');
      else if (
        cause instanceof WorkspaceApiError &&
        (cause.status === 412 ||
          ['FILE_CONFLICT', 'FILE_CHANGED', 'FILE_EXISTS', 'PRECONDITION_FAILED'].includes(
            cause.code || '',
          ))
      )
        setReport('existing');
      else setReport('unknown');
      if (
        writeStarted &&
        (document.activeElement === trigger || document.activeElement === document.body)
      )
        setFocusNext(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="sales-self-service">
      <Text>Find the top-selling state, discover its leading product, and save your findings.</Text>
      <Text size="sm">
        1. Compare states &nbsp;·&nbsp; 2. Explore the leader &nbsp;·&nbsp; 3. Save a report
      </Text>
      {topState && (
        <Text role="status">
          <strong>{topState.label}</strong> leads with{' '}
          <strong>{formatSales(topState.sales)}</strong> in sales.
        </Text>
      )}
      {topProduct && topState && (
        <Text role="status">
          <strong>{topProduct.label}</strong> leads {topState.label} with{' '}
          <strong>{formatSales(topProduct.sales)}</strong> in sales.
        </Text>
      )}
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {report === 'checking' && active && (
        <Text role="status">Checking for an existing report…</Text>
      )}
      {report === 'saved' && (
        <Group>
          <Text>Was this result useful?</Text>
          {feedback ? (
            <Text>Thanks for your feedback.</Text>
          ) : (
            <>
              {[true, false].map((helpful) => (
                <Button
                  key={String(helpful)}
                  variant="subtle"
                  onClick={() => {
                    capture({ name: 'helpful_vote', helpful });
                    setFeedback(true);
                  }}
                >
                  {helpful ? 'Yes' : 'No'}
                </Button>
              ))}
            </>
          )}
        </Group>
      )}
      {(report === 'saved' || report === 'existing') && (
        <Text role="status">
          {report === 'saved' ? 'Report saved.' : 'A report already exists. Open it to review.'}
        </Text>
      )}
      {(report === 'unknown' || report === 'unavailable') && (
        <Alert color="yellow">
          {report === 'unknown'
            ? 'We could not confirm whether the report was saved. Check before trying again; no file will be overwritten.'
            : 'Could not check for an existing report. Try checking again.'}
        </Alert>
      )}
      <Group ref={actions}>
        {!states && (
          <Button
            variant="filled"
            onClick={() => void analyze('states')}
            loading={busy}
            disabled={!canAnalyze || busy || saving}
          >
            Analyze sales by state
          </Button>
        )}
        {topState && !products && (
          <Button
            data-next-step
            variant="filled"
            onClick={() => void analyze('products')}
            loading={busy}
            disabled={!canAnalyze || busy || saving}
          >
            Find {topState.label}’s top product
          </Button>
        )}
        {products && report === 'absent' && (
          <Button
            data-next-step
            variant="filled"
            onClick={() => void saveReport()}
            loading={saving}
            disabled={!canAnalyze || busy}
          >
            Save report
          </Button>
        )}
        {(report === 'unknown' || report === 'unavailable') && (
          <Button
            data-next-step={products ? '' : undefined}
            variant={products ? 'filled' : 'default'}
            onClick={() => void checkReport()}
          >
            Check report
          </Button>
        )}
        {(report === 'saved' || report === 'existing') && (
          <Button
            data-next-step={products ? '' : undefined}
            component="a"
            href={fileHash(resourceId, reportPath, 'preview')}
            variant={products ? 'filled' : 'default'}
          >
            Open report
          </Button>
        )}
        {states && (
          <Button
            variant="subtle"
            onClick={() => void analyze('states')}
            disabled={!canAnalyze || busy || saving}
          >
            Run analysis again
          </Button>
        )}
        <Button component="a" href={fileHash(resourceId, path, 'preview')} variant="subtle">
          Open sample file
        </Button>
      </Group>
      {products && productTotals && (
        <section aria-label="Top products" className="sales-self-service">
          <WorkspaceQueryResults
            sourceResourceId={resourceId}
            result={products}
            busy={false}
            error=""
            footnote="Sales by product · Read-only analysis · Original file unchanged"
          />
        </section>
      )}
      {states && stateTotals && (
        <section aria-label="Sales by state" className="sales-self-service">
          <WorkspaceQueryResults
            sourceResourceId={resourceId}
            result={states}
            busy={false}
            error=""
            footnote="Sales by state · Read-only analysis · Original file unchanged"
          />
        </section>
      )}
    </div>
  );
}
