import type { ApiOptions } from '../client.js';
import type { AuthAdapter, AuthContext, AuthResolution } from './types.js';

export function staticAuth({
  apiKey,
  bearerToken,
}: {
  apiKey?: string;
  bearerToken?: string;
}): AuthAdapter {
  return {
    async authenticate(): Promise<AuthResolution> {
      if ((apiKey && bearerToken) || (!apiKey && !bearerToken))
        return { ok: false, status: 401, message: 'Static API credentials are not configured.' };
      const apiOptions: ApiOptions = apiKey ? { apiKey } : { bearerToken: bearerToken! };
      return { ok: true, apiOptions };
    },
  };
}

export function rejectUnauthenticated(): AuthAdapter {
  return {
    async authenticate(_authContext: AuthContext): Promise<AuthResolution> {
      void _authContext;
      return { ok: false, status: 401, message: 'Authentication is required.' };
    },
  };
}
