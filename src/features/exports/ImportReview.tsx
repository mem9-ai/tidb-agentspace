import { Checkbox, NativeSelect, Table, Text, TextInput } from '@tidbcloud/uikit';
import type { FileExportPreparation } from '../../api/client';
export type ReviewedField = FileExportPreparation['fields'][number] & { selected: boolean };
export function ImportReview({
  review,
  fields,
  onChange,
  busy,
}: {
  review: FileExportPreparation;
  fields: ReviewedField[];
  onChange: (fields: ReviewedField[]) => void;
  busy: boolean;
}) {
  const change = (index: number, patch: Partial<ReviewedField>) =>
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  return (
    <section aria-label="Review parsed data" className="import-review">
      <Text fw={600}>Review fields and types · {review.rowCount} rows</Text>
      <Text size="sm" c="carbon.7" mt="xs">
        Select fields and confirm their destination names and types. TEXT preserves formatting;
        DOUBLE uses approximate floating point. Invalid conversions stop before table creation.
      </Text>
      <div className="import-fields" role="group" aria-label="Import fields">
        {fields.map((field, index) => (
          <div className="import-field" key={field.source}>
            <Checkbox
              label={field.source}
              aria-label={`Include ${field.source}`}
              checked={field.selected}
              disabled={busy}
              onChange={(event) => change(index, { selected: event.currentTarget.checked })}
            />
            <TextInput
              label="Column name"
              aria-label={`Column name for ${field.source}`}
              value={field.name}
              disabled={busy || !field.selected}
              onChange={(event) => change(index, { name: event.currentTarget.value })}
            />
            <NativeSelect
              label="Type"
              aria-label={`Type for ${field.source}`}
              value={field.type}
              disabled={busy || !field.selected}
              data={['TEXT', 'BIGINT', 'DOUBLE', 'BOOLEAN']}
              onChange={(event) => {
                const type = event.currentTarget.value;
                if (type === 'TEXT' || type === 'BIGINT' || type === 'DOUBLE' || type === 'BOOLEAN')
                  change(index, { type });
              }}
            />
          </div>
        ))}
      </div>
      <Text size="sm" c="carbon.7" mt="md">
        Parsed sample · first {review.rows.length} of {review.rowCount} rows. The import uses all{' '}
        {review.rowCount} parsed rows, not the file preview sample.
      </Text>
      <div className="import-sample" role="region" aria-label="Parsed import sample" tabIndex={0}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {review.fields.map((field) => (
                <Table.Th key={field.source}>{field.source}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {review.rows.map((row, index) => (
              <Table.Tr key={index}>
                {review.fields.map((field) => (
                  <Table.Td key={field.source}>
                    {row[field.source] === null
                      ? 'NULL'
                      : typeof row[field.source] === 'object'
                        ? JSON.stringify(row[field.source])
                        : String(row[field.source])}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </section>
  );
}
