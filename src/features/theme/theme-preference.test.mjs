import assert from 'node:assert/strict';
import test from 'node:test';
import {
  migrateThemePreference,
  themeStorageKey,
  legacyThemeStorageKey,
} from './theme-preference.ts';

function storage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('existing light/dark/system choices migrate to TiUI JSON storage once', () => {
  for (const [legacy, expected] of [
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'auto'],
  ]) {
    const store = storage([[legacyThemeStorageKey, legacy]]);
    assert.equal(migrateThemePreference(store), expected);
    assert.equal(store.getItem(themeStorageKey), JSON.stringify(expected));
    assert.equal(store.getItem(legacyThemeStorageKey), null);
    store.setItem(themeStorageKey, '"light"');
    store.setItem(legacyThemeStorageKey, 'dark');
    assert.equal(migrateThemePreference(store), 'light');
  }
});

test('malformed and unsupported persisted values recover to the old choice or system', () => {
  for (const invalid of ['not-json', 'null', '"sepia"', '{}']) {
    assert.equal(
      migrateThemePreference(
        storage([
          [themeStorageKey, invalid],
          [legacyThemeStorageKey, 'dark'],
        ]),
      ),
      'dark',
    );
    assert.equal(migrateThemePreference(storage([[themeStorageKey, invalid]])), 'auto');
  }
  assert.equal(migrateThemePreference(storage()), 'auto');
});

test('unavailable or unwritable storage does not discard a recoverable preference', () => {
  const unavailable = {
    getItem() {
      throw new Error('Storage blocked');
    },
    setItem() {},
    removeItem() {},
  };
  assert.equal(migrateThemePreference(unavailable), 'auto');
  const store = storage([[legacyThemeStorageKey, 'dark']]);
  store.setItem = () => {
    throw new Error('Read only');
  };
  assert.equal(migrateThemePreference(store), 'dark');
  assert.equal(store.getItem(legacyThemeStorageKey), 'dark');
});
