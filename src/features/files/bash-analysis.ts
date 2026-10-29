import type { FileAnalysisCapabilities } from '../../api/client';

export type BashInput = NonNullable<FileAnalysisCapabilities['engines'][number]['input']>;
// Fallback for an independently deployed API predating Workspace-path discovery.
export const legacyBashInput: BashInput = {
  path: '/workspace/input.log',
  workingDirectory: '/workspace',
  aliases: [],
};

export function quoteBashPath(path: string) {
  return "'" + path.replaceAll("'", "'\"'\"'") + "'";
}
export function bashPreviewCommand(path: string) {
  return `head -20 ${quoteBashPath(path)}`;
}
export const bashFileCommand = 'head -20 "$FILE"';
export function bashSamples(path: string, fileVariable?: BashInput['fileVariable']) {
  const input = quoteBashPath(path);
  return [
    { label: 'First lines', value: bashPreviewCommand(path) },
    { label: 'Find errors', value: `grep -n 'ERROR' ${input} | head -20` },
    { label: 'Count lines', value: `wc -l ${input}` },
    ...(fileVariable === 'FILE' ? [{ label: 'Current file ($FILE)', value: bashFileCommand }] : []),
  ];
}
