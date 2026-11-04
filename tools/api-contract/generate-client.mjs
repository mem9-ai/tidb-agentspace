import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import openapiTS, { astToString } from 'openapi-typescript';
import { format, resolveConfig } from 'prettier';

for (const [input, output] of [
  ['portal-regional-openapi.json', 'schema.d.ts'],
  ['portal-global-openapi.json', 'global-schema.d.ts'],
  ['../../public/operator-openapi.json', 'operator-schema.d.ts'],
]) {
  const target = new URL('../../src/api/' + output, import.meta.url);
  const schema = new URL(input, import.meta.url);
  const rendered = await format(
    astToString(
      await openapiTS(schema, {
        transform(node) {
          if (node.format === 'binary') return ts.factory.createTypeReferenceNode('Blob');
        },
      }),
    ),
    {
      ...(await resolveConfig(fileURLToPath(target))),
      parser: 'typescript',
    },
  );
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8')) !== rendered) {
      console.error('Generated client drifted. Run npm run api:generate.');
      process.exitCode = 1;
    } else console.log('Generated API client types are current.');
  } else await writeFile(target, rendered);
}
