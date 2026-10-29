import { useId } from 'react';
import { ActionIcon, Badge, Button, Text } from '@tidbcloud/uikit';
import {
  IconChevronDown,
  IconChevronRight,
  IconCode02,
  IconDatabase01,
} from '@tidbcloud/uikit/icons';
import { WorkspaceBrowserItem } from '../../ui/WorkspaceBrowserItem';
import type { TableMetadata } from './use-table-metadata';

export function DatabaseTableItem({
  name,
  type,
  active,
  expanded,
  busy,
  waiting,
  metadata,
  onToggle,
  onQuery,
}: {
  name: string;
  type: string;
  active: boolean;
  expanded: boolean;
  busy: boolean;
  waiting: boolean;
  metadata: TableMetadata;
  onToggle: () => void;
  onQuery: () => void;
}) {
  const id = useId();
  return (
    <div className="database-table-item">
      <WorkspaceBrowserItem
        name={name}
        description={type === 'VIEW' ? 'View' : 'Table'}
        icon={<IconDatabase01 size={20} />}
        active={active}
        expanded={expanded}
        controls={id}
        disclosure={expanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
        onClick={onToggle}
        actions={
          <ActionIcon
            disabled={busy}
            onClick={onQuery}
            aria-label={`Query ${name} in SQL Editor`}
            title="Query table in SQL Editor"
          >
            <IconCode02 size={18} />
          </ActionIcon>
        }
      />
      <section
        id={id}
        className="database-table-columns"
        aria-label={`Columns for ${name}`}
        hidden={!expanded}
      >
        {active && (
          <>
            {metadata.loading ? (
              <Text size="sm" role="status">
                {waiting ? 'Waiting for database…' : 'Loading columns…'}
              </Text>
            ) : metadata.error ? (
              <div role="alert">
                <Text size="sm">{metadata.error}</Text>
                <Button mt="sm" onClick={metadata.retry} disabled={busy}>
                  Retry columns
                </Button>
              </div>
            ) : (
              metadata.data && (
                <ul className="database-column-list">
                  {metadata.data.columns.map((column) => (
                    <li key={column.name}>
                      <div className="database-column-name">
                        <code title={column.name}>{column.name}</code>
                        {column.key && (
                          <Badge title={column.key === 'PRI' ? 'Primary key' : column.key}>
                            {column.key === 'PRI' ? 'PK' : column.key}
                          </Badge>
                        )}
                      </div>
                      <Text size="sm" c="carbon.7">
                        <code>{column.type}</code> · {column.nullable ? 'Nullable' : 'Not null'}
                      </Text>
                      {column.default !== null && (
                        <Text size="sm" c="carbon.7">
                          Default: <code>{JSON.stringify(column.default)}</code>
                        </Text>
                      )}
                      {column.extra && (
                        <Text size="sm" c="carbon.7">
                          {column.extra}
                        </Text>
                      )}
                    </li>
                  ))}
                </ul>
              )
            )}
          </>
        )}
      </section>
    </div>
  );
}
