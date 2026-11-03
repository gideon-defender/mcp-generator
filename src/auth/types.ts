import type { ExecutionContext } from '../server.js';
import type { ApiOptions } from '../client.js';

export type AuthContext = {
  headers: Headers;
  context?: ExecutionContext;
  transport: 'stdio' | 'http' | 'sse';
};

export type AuthResolution =
  { ok: true; apiOptions: ApiOptions } | { ok: false; status: 401 | 403; message: string };

export interface AuthAdapter {
  authenticate(context: AuthContext): Promise<AuthResolution>;
}
