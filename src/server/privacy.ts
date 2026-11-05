import type { PlatformConfig } from './platform-config.js';

export function localModelUrl(value: string, hosts: string[]): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    throw new Error(
      'LOCAL_ONLY requires a model URL on an explicitly allowed local host.',
    );
  return url;
}

/** Local storage and external-model consent are independent settings. */
export function privacyConfig(config: PlatformConfig): PlatformConfig {
  if (!config.localOnly) return config;
  if (config.conversationStorage !== 'local')
    throw new Error('LOCAL_ONLY requires CONVERSATION_STORAGE=local.');
  if (config.baseUrl)
    localModelUrl(config.baseUrl, config.localModelHosts ?? []);
  process.env.DO_NOT_TRACK = '1';
  process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
  return {
    ...config,
    intelligenceKey: undefined,
    intelligenceApiUrl: undefined,
    intelligenceWsUrl: undefined,
    webSearchProvider: 'disabled',
    composioApiKey: undefined,
    voiceKey: undefined,
    voiceModel: undefined,
    slackChannel: undefined,
    slackTeam: undefined,
    slackUsers: [],
    computerSupervisorUrl: undefined,
    computerSupervisorToken: undefined,
    computerToken: undefined,
    browserUrl: undefined,
    browserSecret: undefined,
  };
}

export function modelFetch(
  config: PlatformConfig,
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    if (config.localOnly) {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const target = localModelUrl(requestUrl, config.localModelHosts ?? []);
      const base = new URL(config.baseUrl);
      if (target.origin !== base.origin)
        throw new Error('Local model requests must use the configured origin.');
    }
    return (config.bcFetch ?? transport)(input, { ...init, redirect: 'error' });
  };
}
