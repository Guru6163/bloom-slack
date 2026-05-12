/**
 * Internal job routes (`/api/internal/*`): `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
 */
export function isAuthorizedInternalRequest(req: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return false;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${key}`;
}
