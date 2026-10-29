import { useEffect, useRef, useState } from 'react';

// Keep a real download link available when the browser defers an asynchronous download.
export function useSnapshotDownload() {
  const [url, setUrl] = useState('');
  const current = useRef('');
  useEffect(() => () => URL.revokeObjectURL(current.current), []);
  function start(content: string, mimeType: string, filename: string) {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = URL.createObjectURL(new Blob([content], { type: mimeType }));
    setUrl(current.current);
    const link = document.createElement('a');
    link.href = current.current;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  }
  return { url, start };
}
