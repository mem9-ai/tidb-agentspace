import { randomUUID } from 'node:crypto';
import { fileExportLimits } from './file-export-contract.mjs';
import { databaseExportPlan, parseResultExport } from './result-exports.mjs';
import { mapImportFields, suggestedImportFields } from './import-fields.mjs';
import { sqlError } from './providers/sql-common.mjs';
import {
  prepareImportInput,
  uploadImportInput,
  commitImportInput,
} from './database-import-contract.mjs';
const invalid = (message) => {
  throw sqlError(400, 'INVALID_FILE_EXPORT', message);
};
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => Object.hasOwn(value, key));
const string = (value) => typeof value === 'string' && value.isWellFormed();
function sourceInput(source, cleanPath) {
  if (
    source?.kind === 'original' &&
    exact(source, ['kind', 'resourceId', 'path']) &&
    string(source.resourceId)
  )
    return { ...source, path: cleanPath(source.path) };
  if (
    source?.kind === 'output' &&
    exact(source, ['kind', 'resourceId', 'stream', 'text']) &&
    string(source.resourceId) &&
    ['stdout', 'stderr'].includes(source.stream) &&
    string(source.text)
  ) {
    if (Buffer.byteLength(source.text) > fileExportLimits.outputBytes)
      throw sqlError(413, 'EXPORT_TOO_LARGE', 'Export up to 1 MiB of output text.');
    return source;
  }
  invalid('Choose an original file or one completed Bash output stream.');
}
function parsingInput(parsing, source) {
  if (
    parsing?.format === 'csv' &&
    exact(parsing, ['format', 'header', 'delimiter']) &&
    typeof parsing.header === 'boolean' &&
    [',', '\t', ';', '|'].includes(parsing.delimiter)
  )
    return parsing;
  if (
    exact(parsing, ['format']) &&
    ['lines', 'parquet'].includes(parsing.format) &&
    !(source.kind === 'output' && parsing.format === 'parquet')
  )
    return parsing;
  invalid('Choose CSV with header/separator, Parquet original, or explicit text lines.');
}
export function createFileExports({ analysis, now = Date.now, limits = fileExportLimits }) {
  const preparations = new Map();
  function prune() {
    for (const [id, entry] of preparations) if (entry.expiresAt <= now()) preparations.delete(id);
  }
  async function parseAndStore(source, parsing, { actor, signal }, resource, destination, bytes) {
    const parsed = await analysis.parse(
      resource,
      {
        path:
          source.kind === 'original'
            ? source.path
            : source.kind === 'upload'
              ? '/' + source.filename
              : '/command-output.' + (parsing.format === 'lines' ? 'txt' : 'csv'),
        parsing,
        ...(bytes !== undefined
          ? { bytes }
          : source.kind === 'output'
            ? { bytes: Buffer.from(source.text) }
            : {}),
      },
      signal,
    );
    // Enforce finite JSON values/nesting and total snapshot budget independently of the worker.
    const result = parseResultExport({
      sourceResourceId: source.resourceId,
      result: { columns: parsed.columns, rows: parsed.rows },
      target: { kind: 'download', format: 'json' },
    }).result;
    const entry = {
      actor,
      destination,
      source:
        source.kind !== 'output'
          ? source
          : { kind: source.kind, resourceId: source.resourceId, stream: source.stream },
      sourceVersion: parsed.fileVersion,
      parsed: { ...result, columnTypes: parsed.columnTypes },
      expiresAt: now() + limits.preparationMs,
      used: false,
    };
    prune();
    while (preparations.size >= limits.preparations)
      preparations.delete(preparations.keys().next().value);
    const preparationId = randomUUID();
    preparations.set(preparationId, entry);
    return {
      preparationId,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      fields: suggestedImportFields(entry.parsed, parsing.format),
      rows: result.rows.slice(0, 20),
      rowCount: result.rows.length,
      sourceVersion: parsed.fileVersion,
      inputBytes: parsed.inputBytes,
      format: parsing.format,
    };
  }
  return {
    close() {
      preparations.clear();
    },
    async prepare(input, context) {
      if (!exact(input, ['source', 'parsing'])) invalid('Choose source and parsing options only.');
      const source = sourceInput(input.source, context.cleanPath),
        parsing = parsingInput(input.parsing, source);
      const resource = context.authorize(
        { sourceResourceId: source.resourceId, target: { kind: 'download' } },
        { fileSource: true },
      );
      return parseAndStore(source, parsing, context, resource);
    },
    async prepareImport(input, context, bytes) {
      if (bytes !== undefined && bytes.length > 1024 * 1024)
        throw sqlError(413, 'FILE_TOO_LARGE', 'Local import uploads are limited to 1 MiB.');
      const value =
        bytes === undefined
          ? prepareImportInput(input, context.cleanPath)
          : uploadImportInput(input);
      const destination = context.authorize({
        sourceResourceId: value.resourceId,
        target: { kind: 'database', resourceId: value.resourceId },
      });
      const source =
        bytes === undefined
          ? value.source
          : { kind: 'upload', resourceId: value.resourceId, filename: value.filename };
      const resource =
        bytes === undefined
          ? context.authorize(
              { sourceResourceId: source.resourceId, target: { kind: 'download' } },
              { fileSource: true },
            )
          : destination;
      return parseAndStore(source, value.parsing, context, resource, value.resourceId, bytes);
    },
    async commitImport(input, context) {
      const value = commitImportInput(input);
      prune();
      const entry = preparations.get(value.preparationId);
      if (!entry || entry.actor !== context.actor)
        throw sqlError(409, 'IMPORT_PREPARATION_UNAVAILABLE', 'Parse and review again.');
      if (entry.destination !== value.resourceId)
        throw sqlError(
          409,
          'IMPORT_TARGET_MISMATCH',
          'This review belongs to a different database. Parse and review again.',
        );
      return this.export(
        {
          preparationId: value.preparationId,
          confirmed: true,
          fields: value.fields,
          target: { kind: 'database', resourceId: value.resourceId, table: value.table },
        },
        context,
      );
    },
    async export(input, { actor, authorize, cleanPath, signal, createFile, execute, record }) {
      if (Object.hasOwn(input || {}, 'preparationId')) {
        if (
          !exact(input, ['preparationId', 'confirmed', 'fields', 'target']) ||
          !string(input.preparationId) ||
          input.confirmed !== true ||
          !exact(input.target, ['kind', 'resourceId', 'table']) ||
          input.target.kind !== 'database' ||
          !string(input.target.resourceId) ||
          !string(input.target.table)
        )
          invalid('Confirm the reviewed fields and a new database table.');
        prune();
        const entry = preparations.get(input.preparationId);
        if (!entry || entry.actor !== actor)
          throw sqlError(
            409,
            'IMPORT_PREPARATION_UNAVAILABLE',
            'This review is expired, unavailable or belongs to another session. Parse and review again.',
          );
        if (entry.used)
          throw sqlError(
            409,
            'IMPORT_ALREADY_COMMITTED',
            'This review has already started a write. Inspect its destination before preparing another import.',
          );
        if (entry.destination && entry.destination !== input.target.resourceId)
          throw sqlError(
            409,
            'IMPORT_TARGET_MISMATCH',
            'This review belongs to a different database.',
          );
        const fileSource = entry.source.kind !== 'upload';
        const context = { sourceResourceId: entry.source.resourceId, target: input.target };
        const resource = authorize(context, { fileSource });
        const result = mapImportFields(entry.parsed, input.fields);
        const plan = databaseExportPlan(
          result,
          input.target.table,
          resource.kind,
          input.fields.map((field) => field.type),
        );
        if (entry.source.kind === 'original') {
          const source = authorize({ ...context, target: { kind: 'download' } }, { fileSource });
          const current = await analysis.read(source, entry.source.path, signal);
          if (current.fileVersion !== entry.sourceVersion)
            throw sqlError(
              409,
              'FILE_CHANGED',
              'The original changed since review. Parse and review it again before importing.',
            );
        }
        // Recheck after asynchronous version I/O: another request may have claimed the same handle.
        if (entry.used)
          throw sqlError(
            409,
            'IMPORT_ALREADY_COMMITTED',
            'This review has already started a write. Inspect the destination.',
          );
        if (entry.expiresAt <= now())
          throw sqlError(
            409,
            'IMPORT_PREPARATION_UNAVAILABLE',
            'This review expired. Parse and review again.',
          );
        authorize(context, { fileSource });
        signal?.throwIfAborted();
        entry.used = true;
        try {
          await execute(resource, plan.create, signal);
        } catch (error) {
          if (error.code === 'SQL_TABLE_EXISTS') entry.used = false;
          throw error;
        }
        try {
          if (plan.insert) {
            authorize(context, { fileSource });
            signal?.throwIfAborted();
            await execute(resource, plan.insert, signal);
          }
        } catch {
          throw sqlError(
            502,
            'EXPORT_INCOMPLETE',
            `Table "${input.target.table}" was created, but its data write did not finish successfully. Inspect the table before retrying; it may be empty or already contain the rows.`,
          );
        }
        await record(input.target, result.rows.length);
        return {
          kind: 'database',
          resourceId: resource.id,
          table: input.target.table,
          columns: plan.columns,
          rowCount: result.rows.length,
        };
      }
      if (!exact(input, ['source', 'target'])) invalid('Choose a source and destination.');
      const source = sourceInput(input.source, cleanPath),
        target = input.target;
      if (
        !(exact(target, ['kind']) && target.kind === 'download') &&
        !(
          exact(target, ['kind', 'resourceId', 'path']) &&
          target.kind === 'filesystem' &&
          string(target.resourceId) &&
          string(target.path)
        )
      )
        invalid(
          'Choose Download or a new File System path. Database imports require a reviewed preparation.',
        );
      if (source.kind === 'original' && target.kind === 'download')
        invalid('Use the original file content download endpoint.');
      const options = { readOnlySource: source.kind === 'original', fileSource: true };
      const context = { sourceResourceId: source.resourceId, target };
      const destination = authorize(context, options);
      if (target.kind === 'download')
        return {
          kind: 'download',
          filename: `command-${source.stream}.txt`,
          mimeType: 'text/plain;charset=utf-8',
          content: source.text,
          bytes: Buffer.byteLength(source.text),
        };
      const path = cleanPath(target.path);
      if (path === '/' || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
        invalid('Choose a file path without control characters.');
      let bytes;
      if (source.kind === 'original') {
        const resource = authorize({ ...context, target: { kind: 'download' } }, options);
        bytes = (await analysis.read(resource, source.path, signal)).bytes;
      } else bytes = Buffer.from(source.text);
      let content = bytes;
      if (destination.provider !== 'drive9-anonymous') {
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw sqlError(
            422,
            'LOCAL_BINARY_UNSUPPORTED',
            'Local File Systems store UTF-8 text. Choose a live File System for binary copies.',
          );
        }
      }
      await createFile({
        resource: destination,
        path,
        artifact: { content, bytes: bytes.length },
        authorize: () => {
          signal?.throwIfAborted();
          return authorize(context, options);
        },
        record: () => record(target, undefined),
      });
      return { kind: 'filesystem', resourceId: destination.id, path, bytes: bytes.length };
    },
  };
}
