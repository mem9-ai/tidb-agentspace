import { sqlError } from './providers/sql-common.mjs';

export function tableName(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].length > 64 ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !value.isWellFormed()
  )
    throw sqlError(
      400,
      'INVALID_TABLE_NAME',
      'Choose a table name of 1–64 characters without control characters.',
    );
  return value;
}
