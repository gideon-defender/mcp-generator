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
  /** Additional per-invocation gate after authentication and schema validation, before upstream execution.
   * Runs for static/dynamic calls and each composite subcall. Discovery does not invoke it.
   */
  authorizeTool?(context: AuthToolContext): Promise<AuthResolution>;
}

export type AuthToolContext = AuthContext & {
  tool: {
    name: string;
    classification: 'read' | 'mutate';
    operationId?: string;
    method?: string;
    path?: string;
  };
  /** The actual normalized arguments that will be serialized upstream. */
  input: unknown;
};
