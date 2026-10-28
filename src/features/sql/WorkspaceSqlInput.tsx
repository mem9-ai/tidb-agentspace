import { useEffect, useMemo, useRef } from 'react';
import { useComputedColorScheme, useMantineTheme } from '@tidbcloud/uikit';
import {
  EditorCacheProvider,
  SQLEditor,
  useEditorCacheContext,
} from '@tidbcloud/tisqleditor-react';
import { bbedit, oneDark } from '@tidbcloud/codemirror-extension-themes';
import { MySQL, StandardSQL } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

type Props = {
  databaseId: string;
  dialect: 'mysql' | 'duckdb';
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
};
function Editor({ databaseId, dialect, value, onChange, onRun }: Props) {
  const cache = useEditorCacheContext();
  const callbacks = useRef({ onChange, onRun });
  useEffect(() => {
    callbacks.current = { onChange, onRun };
  }, [onChange, onRun]);
  const scheme = useComputedColorScheme('light');
  const palette = useMantineTheme();
  const sqlConfig = useMemo(
    () => ({ dialect: dialect === 'duckdb' ? StandardSQL : MySQL, upperCaseKeywords: true }),
    [dialect],
  );
  const theme = useMemo(
    () => [
      EditorView.theme({
        '&': {
          fontSize: '16px',
          backgroundColor: palette.colors.carbon[0],
          color: palette.colors.carbon[8],
        },
        '.cm-scroller': {
          fontFamily: palette.fontFamilyMonospace,
          lineHeight: '1.7',
          overflow: 'auto',
        },
        '.cm-content': { minHeight: '260px', padding: '20px 0' },
        '.cm-gutters': {
          backgroundColor: palette.colors.carbon[2],
          color: palette.colors.carbon[7],
          borderColor: palette.colors.carbon[4],
        },
      }),
      scheme === 'dark' ? oneDark : bbedit,
    ],
    [scheme, palette],
  );
  const extensions = useMemo(
    () => [
      EditorView.contentAttributes.of({
        'aria-label': 'SQL query',
        role: 'textbox',
        'aria-multiline': 'true',
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
      }),
      // Override CodeMirror's default Mod-Enter (insert blank line).
      Prec.high(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              callbacks.current.onRun();
              return true;
            },
          },
        ]),
      ),
      EditorView.lineWrapping,
    ],
    [],
  );
  useEffect(() => {
    const view = cache.getEditor(databaseId)?.editorView;
    if (view && value !== view.state.doc.toString())
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [cache, databaseId, value]);
  return (
    <SQLEditor
      className="sql-input"
      editorId={databaseId}
      doc={value}
      theme={theme}
      sqlConfig={sqlConfig}
      extraExts={extensions}
      basicSetupOptions={{ autocompletion: true, foldGutter: false }}
    />
  );
}

export default function WorkspaceSqlInput(props: Props) {
  // The resource panel owns the cache; leaving/switching releases its editor and old results.
  return (
    <EditorCacheProvider>
      <Editor {...props} />
    </EditorCacheProvider>
  );
}
