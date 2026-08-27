// Helper condivisi per le route agent (usati da agent.js e crm-agent.js).
// requireAgent verifica che l'utente sia un agente (token API o JWT agent).
export function requireAgent(req, res, next) {
  if (!req.user?.agent) {
    return res.status(403).json({ error: "Solo per agenti" });
  }
  next();
}

export async function canAccessSite(user, siteId) {
  const sid = parseInt(siteId, 10);
  if (!Number.isInteger(sid) || sid < 1) return false;
  if (user.role === "superadmin") return true;
  return user.site_id === sid;
}

export const parseIntParam = (value, fallback = 0) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};
