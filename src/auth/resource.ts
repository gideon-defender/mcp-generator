export type ProtectedResourceOptions = {
  /** Canonical externally reachable MCP URL, never inferred from request headers. */
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly string[];
};

/** HTTPS in production; HTTP is accepted only for loopback development endpoints. */
export function trustedOAuthUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'OAuth URLs must use HTTPS (or loopback HTTP) without credentials, query, or fragment.',
    );
  return url;
}

export function prepareProtectedResource(options: ProtectedResourceOptions) {
  const resource = trustedOAuthUrl(options.resource);
  if (!options.authorizationServers.length) throw new Error('An authorization server is required.');
  for (const issuer of options.authorizationServers) trustedOAuthUrl(issuer);
  const scopes = options.scopesSupported ?? [];
  if (scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)))
    throw new Error('Invalid OAuth scope.');
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`;
  const metadataUrl = new URL(metadataPath, resource.origin).href;
  const document = {
    resource: options.resource,
    authorization_servers: [...options.authorizationServers],
    bearer_methods_supported: ['header'],
    ...(scopes.length ? { scopes_supported: [...scopes] } : {}),
  };
  return {
    resource,
    document,
    metadataPath,
    challenge(
      error?: 'invalid_token' | 'insufficient_scope',
      requiredScopes: readonly string[] = [],
    ) {
      if (requiredScopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)))
        throw new Error('Invalid OAuth scope.');
      return (
        `Bearer resource_metadata="${metadataUrl}"` +
        (error ? `, error="${error}"` : '') +
        (requiredScopes.length ? `, scope="${requiredScopes.join(' ')}"` : '')
      );
    },
  };
}
