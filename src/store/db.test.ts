import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, deleteDatabase, SCHEMA_VERSION } from './db';
import { loadDataset } from './dataset';

describe('ouverture de la base', () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it("s'ouvre sur un dataset vide quand rien n'a encore été collecté", async () => {
    await getDb();
    const dataset = await loadDataset();
    expect(dataset.projects.size).toBe(0);
    expect(dataset.daily.size).toBe(0);
    expect(dataset.meta).toBeNull();
  });

  it('crée exactement les magasins que le code lit', async () => {
    const db = await getDb();
    expect(db.version).toBe(SCHEMA_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'authors',
      'daily',
      'handles',
      'meta',
      'overview',
      'projects',
      'recentCommits',
    ]);
  });
});
