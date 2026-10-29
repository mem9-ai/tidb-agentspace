import { useState, type ReactNode } from 'react';
import { ResultExportDialog } from '../features/exports/ResultExportDialog';
import { Alert, Badge, Button, Paper, Table, Text } from '@tidbcloud/uikit';
import { IconCheckCircle, IconDownload01 } from '@tidbcloud/uikit/icons';
import { Heading } from './WorkspaceHeading';
import './workspace-execution.css';

type Rows = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affectedRows?: number;
};

export function WorkspaceResultPanel({
  title = 'Results',
  badge,
  actions,
  footnote,
  children,
}: {
  title?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper className="panel workspace-results" withBorder>
      <div className="panel-header">
        <Heading level={2}>
          {title} {badge}
        </Heading>
        {actions}
      </div>
      {children}
      {footnote && (
        <div className="result-footnote">
          <IconCheckCircle size={16} /> {footnote}
        </div>
      )}
    </Paper>
  );
}

export function WorkspaceQueryResults({
  result,
  busy,
  error,
  footnote,
  sourceResourceId,
  onExportSaved,
}: {
  result: Rows | null;
  busy: boolean;
  error: string;
  footnote?: ReactNode;
  sourceResourceId: string;
  onExportSaved?: () => Promise<void> | void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <>
      <WorkspaceResultPanel
        badge={
          result && (
            <Badge color="green">
              {result.columns.length
                ? `${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}`
                : `${result.affectedRows ?? 0} affected`}
            </Badge>
          )
        }
        actions={
          result &&
          result.columns.length > 0 && (
            <Button
              leftSection={<IconDownload01 size={18} />}
              disabled={busy}
              onClick={() => setExportOpen(true)}
            >
              Export results
            </Button>
          )
        }
        footnote={result ? footnote : undefined}
      >
        {error ? (
          <Alert className="workspace-result-message" color="red" role="alert" p="lg">
            {error}
          </Alert>
        ) : result ? (
          <div
            className="table-scroll workspace-result-table"
            role="region"
            aria-label="Query result data"
            tabIndex={0}
          >
            <Table verticalSpacing={12} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  {result.columns.map((column) => (
                    <Table.Th key={column}>{column}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.rows.map((row, index) => (
                  <Table.Tr key={index}>
                    {result.columns.map((column) => (
                      <Table.Td key={column}>
                        <code>
                          {row[column] === null
                            ? 'NULL'
                            : typeof row[column] === 'object'
                              ? JSON.stringify(row[column])
                              : String(row[column])}
                        </code>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {!result.rowCount && result.columns.length > 0 && <Text p="lg">No rows returned.</Text>}
          </div>
        ) : (
          <Text className="workspace-result-message" role="status" p="lg" m={0}>
            {busy ? 'Running query…' : 'Run a query to see its results here.'}
          </Text>
        )}
      </WorkspaceResultPanel>
      {exportOpen && result && (
        <ResultExportDialog
          sourceResourceId={sourceResourceId}
          result={{ columns: result.columns, rows: result.rows }}
          onClose={() => setExportOpen(false)}
          onSaved={onExportSaved}
        />
      )}
    </>
  );
}
