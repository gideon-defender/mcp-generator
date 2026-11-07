import type { ExecutionContext } from '../server.js';
import type { ApiOptions } from '../client.js';

export type AuthContext = {
  headers: Headers;
  context?: ExecutionContext;
  transport: 'stdio' | 'http' | 'sse';
};

export type AuthResolution =
  | { ok: true; apiOptions: ApiOptions }
  | {
      ok: false;
      status: 401 | 403 | 503;
      message: string;
      error?: 'invalid_token' | 'insufficient_scope';
      /** Scopes required for this request, not the resource's full supported scope list. */
      requiredScopes?: readonly string[];
    };

export interface AuthAdapter {
  authenticate(context: AuthContext): Promise<AuthResolution>;
}
