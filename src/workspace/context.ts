import pg from 'pg';

export type Queryable = {
  query: pg.PoolClient['query'];
};

export interface WorkspaceContext {
  workspaceId: string;
  workspaceKey: string;
  userId: string;
  userKey: string;
  role: 'OWNER' | 'MEMBER' | 'READER';
}

export interface ResolveWorkspaceContextOptions {
  workspaceKey: string;
  userKey: string;
}

export const DEFAULT_WORKSPACE_KEY = 'default';
export const DEFAULT_USER_KEY = 'local_user';

export function getWorkspaceKeyFromEnv(): string {
  return (process.env.WORKSPACE_KEY || DEFAULT_WORKSPACE_KEY).trim();
}

export function getUserKeyFromEnv(): string {
  return (process.env.WORKSPACE_USER_KEY || process.env.USER_KEY || DEFAULT_USER_KEY).trim();
}

export async function resolveWorkspaceContext(
  client: Queryable,
  options?: Partial<ResolveWorkspaceContextOptions>
): Promise<WorkspaceContext> {
  const workspaceKey = (options?.workspaceKey || getWorkspaceKeyFromEnv()).trim();
  const userKey = (options?.userKey || getUserKeyFromEnv()).trim();

  const { rows } = await client.query<{
    workspace_id: string;
    user_id: string;
    role: 'OWNER' | 'MEMBER' | 'READER';
  }>(
    `
      SELECT
        w.id AS workspace_id,
        u.id AS user_id,
        m.role AS role
      FROM workspaces w
      JOIN workspace_memberships m ON m.workspace_id = w.id
      JOIN workspace_users u ON u.id = m.user_id
      WHERE w.workspace_key = $1
        AND u.user_key = $2
        AND m.status = 'ACTIVE'
      LIMIT 1
    `,
    [workspaceKey, userKey]
  );

  if (rows.length === 0) {
    throw new Error(`Unauthorized: no ACTIVE membership for user_key=${userKey} in workspace_key=${workspaceKey}`);
  }

  return {
    workspaceId: rows[0].workspace_id,
    workspaceKey,
    userId: rows[0].user_id,
    userKey,
    role: rows[0].role,
  };
}

