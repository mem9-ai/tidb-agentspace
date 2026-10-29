import { useEffect, useState } from 'react';
import { Alert, Button, Group, Loader, Table, Text } from '@tidbcloud/uikit';
import { workspaceApi, type TabularFilePreview as Preview } from '../../api/client';

export function useTabularPreview(
  resourceId: string,
  path: string,
  savedContent: string,
  enabled: boolean,
) {
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    workspaceApi
      .tabularFilePreview(resourceId, path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Unable to preview this file.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resourceId, path, savedContent, enabled, revision]);
  return { data, error, loading, refresh: () => setRevision((value) => value + 1) };
}

export function TabularFilePreview({
  data,
  error,
  loading,
  onRefresh,
  disabled,
}: {
  data: Preview | null;
  error: string;
  loading: boolean;
  onRefresh: () => void;
  disabled: boolean;
}) {
  if (loading)
    return (
      <Group p="lg">
        <Loader size="sm" />
        <Text>Loading data preview…</Text>
      </Group>
    );
  if (!data)
    return (
      <Alert color="yellow" title="Data preview unavailable" m="lg">
        <Text>
          {error || 'No data preview is available.'} Use Export to download the file and open it in
          another tool.
        </Text>
        <Button mt="md" onClick={onRefresh} disabled={disabled}>
          Retry preview
        </Button>
      </Alert>
    );
  return (
    <div className="tabular-file-preview">
      <Group justify="space-between" gap="sm" p="md">
        <Text size="sm" c="carbon.7">
          {data.totalRows === null ? 'Total rows unknown' : `${data.totalRows} rows`} ·{' '}
          {data.columns.length} columns · {data.typesInferred ? 'Inferred types' : 'Parquet types'}
        </Text>
        <Button variant="subtle" onClick={onRefresh} disabled={disabled}>
          Refresh preview
        </Button>
      </Group>
      <div
        className="file-csv-scroll tabular-preview-table"
        role="region"
        aria-label="File data preview"
        tabIndex={0}
      >
        <Table stickyHeader verticalSpacing={12}>
          <Table.Thead>
            <Table.Tr>
              {data.columns.map((column, i) => (
                <Table.Th key={column}>
                  {column}
                  <Text size="sm" c="carbon.7" fw={400}>
                    {data.columnTypes[i]}
                  </Text>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.rows.map((row, i) => (
              <Table.Tr key={i}>
                {data.columns.map((column) => (
                  <Table.Td key={column}>
                    {row[column] === null ? (
                      <Text component="span" c="carbon.7">
                        NULL
                      </Text>
                    ) : typeof row[column] === 'object' ? (
                      JSON.stringify(row[column])
                    ) : (
                      String(row[column])
                    )}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Text size="sm" c="carbon.7" px="md" py="sm">
        Sample · {data.rowCount ? `First ${data.rowCount} rows` : 'No rows'}
        {data.truncated ? ' · More rows available through analysis or download' : ''}
      </Text>
      <details className="file-schema-details">
        <summary>File schema ({data.schema.length})</summary>
        {data.schema.map((column) => (
          <Text key={column.column_name} size="sm" py={4}>
            <strong>{column.column_name}</strong> · {column.column_type}
          </Text>
        ))}
      </details>
    </div>
  );
}
