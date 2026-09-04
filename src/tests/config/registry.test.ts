import { describe, expect, it, vi } from 'vitest';
import { upsertConfigRevision } from '../../config/registry.js';
import { sha256Hex, stableStringify } from '../../config/structuredLoader.js';

describe('upsertConfigRevision', () => {
  const ctx = {
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceKey: 'default',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    userKey: 'local_user',
    role: 'OWNER' as const,
  };

  it('inserts a new revision and activation event with a stable content hash', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];

    const query = vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO config_definitions')) {
        return { rows: [{ id: 'def-1' }] };
      }
      if (sql.includes('SELECT id, revision_number') && sql.includes('FROM config_revisions')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE(MAX(revision_number)')) {
        return { rows: [{ next: 1 }] };
      }
      if (sql.includes('INSERT INTO config_revisions')) {
        return { rows: [{ id: 'rev-1' }] };
      }
      if (sql.includes('SELECT config_revision_id') && sql.includes('FROM config_active_revisions')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const content = { b: 2, a: { z: 1, y: 2 } };
    const expectedHash = sha256Hex(stableStringify(content));

    const result = await upsertConfigRevision(
      {
        configKey: 'sources',
        configType: 'SOURCES',
        description: 'Sources config',
        schemaVersion: '2.2.0',
        content,
      },
      fakePool,
      { context: ctx }
    );

    expect(result.configDefinitionId).toBe('def-1');
    expect(result.configRevisionId).toBe('rev-1');
    expect(result.revisionNumber).toBe(1);
    expect(result.contentHash).toBe(expectedHash);
    expect(result.activated).toBe(true);

    const defInsert = calls.find((c) => c.sql.includes('INSERT INTO config_definitions'));
    expect(defInsert?.params?.[0]).toBe(ctx.workspaceId);

    expect(calls.some((c) => c.sql.includes('INSERT INTO config_active_revisions'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO config_activation_events'))).toBe(true);
  });

  it('can skip activation when activate=false', async () => {
    const calls: string[] = [];

    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO config_definitions')) {
        return { rows: [{ id: 'def-2' }] };
      }
      if (sql.includes('SELECT id, revision_number') && sql.includes('FROM config_revisions')) {
        return { rows: [{ id: 'rev-existing', revision_number: 3 }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const result = await upsertConfigRevision(
      {
        configKey: 'lanes_registry',
        configType: 'LANES',
        content: { lanes: [] },
      },
      fakePool,
      { context: ctx, activate: false }
    );

    expect(result.configRevisionId).toBe('rev-existing');
    expect(result.revisionNumber).toBe(3);
    expect(result.activated).toBe(false);

    expect(calls.some((sql) => sql.includes('config_active_revisions'))).toBe(false);
    expect(calls.some((sql) => sql.includes('config_activation_events'))).toBe(false);
  });
});

