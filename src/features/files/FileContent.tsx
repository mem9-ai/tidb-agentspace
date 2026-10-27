import { Component, useMemo, type ReactNode } from 'react';
import { Alert, Table, Text } from '@tidbcloud/uikit';
import { CodeBlock } from '@tidbcloud/uikit/biz';
import { MarkdownPreview } from './MarkdownPreview';
import { prepareFilePreview } from './file-preview';

function UnavailablePreview({ reason }: { reason: string }) {
  return (
    <Alert color="yellow" title="Preview unavailable" role="status">
      <Text>{reason}</Text>
      <Text mt={12}>Download the file to open it in another application.</Text>
    </Alert>
  );
}

// A renderer failure must not take down the panel's download/close controls or the workspace.
export class FilePreviewBoundary extends Component<
  { content: string; path: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { content: string; path: string }) {
    if (
      this.state.failed &&
      (previous.path !== this.props.path || previous.content !== this.props.content)
    ) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? (
      <UnavailablePreview reason="The file renderer could not display this content." />
    ) : (
      this.props.children
    );
  }
}

export function FileContent({ path, content }: { path: string; content: string }) {
  const preview = useMemo(() => prepareFilePreview(path, content), [path, content]);
  if (!content)
    return <Text c="carbon.7">This file is empty. Choose Edit source to add content.</Text>;
  if (preview.kind === 'unavailable') return <UnavailablePreview reason={preview.reason} />;
  if (preview.kind === 'markdown')
    return (
      <article className="file-markdown">
        <MarkdownPreview content={content} />
      </article>
    );
  if (preview.kind === 'csv')
    return (
      <>
        <div className="file-csv-scroll" tabIndex={0} aria-label="CSV table">
          <Table withColumnBorders withTableBorder>
            <Table.Thead>
              <Table.Tr>
                {preview.rows[0]?.map((cell, i) => (
                  <Table.Th key={i}>{cell || `Column ${i + 1}`}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.rows.slice(1).map((row, i) => (
                <Table.Tr key={i}>
                  {row.map((cell, j) => (
                    <Table.Td key={j}>{cell}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {preview.truncated && (
          <Text size="sm" mt={16}>
            Showing the first 200 rows. Download the file for all rows.
          </Text>
        )}
      </>
    );
  if (preview.kind === 'json' || preview.kind === 'code')
    return (
      <CodeBlock
        language={preview.language}
        withCopyButton={false}
        codeHighlightProps={{ trim: false, styles: { code: { fontSize: 16, lineHeight: 1.7 } } }}
      >
        {preview.content}
      </CodeBlock>
    );
  return <pre className="file-text-preview">{content}</pre>;
}
