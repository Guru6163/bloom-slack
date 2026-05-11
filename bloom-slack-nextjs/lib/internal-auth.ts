/**
 * Internal job routes use the same bearer token as Supabase Edge Functions:
 * `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
 */
export function isAuthorizedInternalRequest(req: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return false;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${key}`;
}
