import { createClient } from '@supabase/supabase-js';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
function origin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new Error('Invalid invitation service origin');
  }
  return url.origin;
}
export function createProjectInvitationSender(options: {
  supabaseUrl: string;
  serviceRoleKey: string;
  webOrigin: string;
}) {
  const supabaseUrl = origin(options.supabaseUrl),
    webOrigin = origin(options.webOrigin);
  if (!options.serviceRoleKey)
    throw new Error('Invitation service credential required');
  const client = createClient(supabaseUrl, options.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        }),
    },
  });
  return async (email: string): Promise<{ actorId: string }> => {
    try {
      const { data, error } = await client.auth.admin.inviteUserByEmail(email, {
        redirectTo: webOrigin + '/zh-CN/auth/invite',
      });
      if (error || !data.user) throw new Error('Delivery unavailable');
      return { actorId: PlatformUuidSchema.parse(data.user.id) };
    } catch {
      throw new Error('Invitation delivery unavailable');
    }
  };
}
