import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ApiOptions } from '../client.js';
import type { AuthAdapter, AuthContext, AuthResolution } from './types.js';

export type OAuthAuthOptions = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  requiredScopes?: readonly string[];
  upstreamBearerToken?: boolean;
};

export function oauthAuth(options: OAuthAuthOptions): AuthAdapter {
  const issuer = options.issuer.trim();
  const audience = options.audience.trim();
  const jwksUrl = options.jwksUrl.trim();
  if (!issuer || !audience || !jwksUrl)
    throw new Error('OAuth auth requires issuer, audience, and jwksUrl.');
  const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));
  return {
    async authenticate(authContext: AuthContext): Promise<AuthResolution> {
      const authorization = authContext.headers.get('authorization')?.trim() ?? '';
      if (!authorization.toLowerCase().startsWith('bearer '))
        return { ok: false, status: 401, message: 'Bearer token is required.' };
      const token = authorization.slice(7).trim();
      if (!token) return { ok: false, status: 401, message: 'Bearer token is required.' };
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, remoteJwks, { issuer, audience }));
      } catch {
        return { ok: false, status: 401, message: 'Bearer token is invalid.' };
      }
      if (!hasRequiredScopes(payload, options.requiredScopes ?? []))
        return { ok: false, status: 403, message: 'Required scopes are missing.' };
      const apiOptions = resolveApiOptions({ payload, token, options });
      if (!apiOptions)
        return {
          ok: false,
          status: 403,
          message: 'No upstream credential is available for this identity.',
        };
      return { ok: true, apiOptions };
    },
  };
}

function hasRequiredScopes(payload: JWTPayload, requiredScopes: readonly string[]): boolean {
  const scopeValue = typeof payload.scope === 'string' ? payload.scope : '';
  const scopes = new Set(scopeValue.split(/\s+/).filter(Boolean));
  return requiredScopes.every((scope) => scopes.has(scope));
}

function resolveApiOptions({
  payload,
  token,
  options,
}: {
  payload: JWTPayload;
  token: string;
  options: OAuthAuthOptions;
}): ApiOptions | undefined {
  if (options.upstreamBearerToken) return { bearerToken: token };
  const apiKey = typeof payload.api_key === 'string' ? payload.api_key.trim() : '';
  return apiKey ? { apiKey } : undefined;
}
