// Virtual input exposed by the selected-file analysis worker, not a Workspace file path.
export const bashInputPath = '/workspace/input.log';
export const bashPreviewCommand = `head -20 ${bashInputPath}`;
export const bashSamples = [
  { label: 'First lines', value: bashPreviewCommand },
  { label: 'Find errors', value: `grep -n 'ERROR' ${bashInputPath} | head -20` },
  { label: 'Count lines', value: `wc -l ${bashInputPath}` },
];
