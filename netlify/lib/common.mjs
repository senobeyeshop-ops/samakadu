// Outils partagés par les fonctions Netlify. Aucun secret ici : tout vient des variables d'environnement.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

// Noms acceptés pour chaque variable (les seconds sont ceux déjà saisis dans Netlify).
const ALIASES = {
  SUPABASE_ANON_KEY: ["ANON_KEY", "SUPABASE_KEY"],
  SUPABASE_SERVICE_ROLE_KEY: ["SERVICE_ROLE_SECRET", "SERVICE_ROLE_KEY"],
};
const read = (k) => process.env[k] || globalThis.Netlify?.env?.get?.(k) || "";
// Nettoie les copier-coller : espaces, retours à la ligne, guillemets et « Bearer » collés par erreur.
const clean = (v) => String(v || "").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^Bearer\s+/i, "").trim();
export const env = (k) => clean([k, ...(ALIASES[k] || [])].map(read).find(Boolean));
export const envOnly = (k) => clean(read(k));

export const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const siteUrl = () => (env("URL") || "").replace(/\/$/, "");

// Requête Supabase au nom de l'utilisateur : les règles RLS s'appliquent.
export const sbUser = (path, token, init = {}) =>
  fetch(`${env("SUPABASE_URL")}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
    headers: { apikey: env("SUPABASE_ANON_KEY"), authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });

// Requête Supabase avec la clé de service (uniquement côté serveur : valider un paiement).
export const sbService = (path, init = {}) => {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) throw new Error("missing service key");
  return fetch(`${env("SUPABASE_URL")}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
    headers: { apikey: k, ...(k.startsWith("eyJ") ? { authorization: `Bearer ${k}` } : {}), "content-type": "application/json", ...(init.headers || {}) },
  });
};

export const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

export async function getUser(token) {
  if (!token) return null;
  const r = await sbUser("/auth/v1/user", token);
  return r.ok ? r.json() : null;
}

export function originOk(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // même origine ou appel serveur
  const allowed = [
    env("URL"), env("DEPLOY_PRIME_URL"), env("DEPLOY_URL"),
    env("SITE_NAME") && `https://${env("SITE_NAME")}.netlify.app`,
    ...env("ALLOWED_ORIGINS").split(",").map((s) => s.trim()),
  ].filter(Boolean);
  return !allowed.length || allowed.includes(origin);
}

export const hmacHex = (key, msg) => createHmac("sha256", key).update(msg, "utf8").digest("hex");
export const sha256Hex = (msg) => createHash("sha256").update(msg, "utf8").digest("hex");
export function safeEq(a, b) {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export async function markPaid(orderId, amount, ref) {
  const r = await sbService("/rest/v1/rpc/mark_order_paid", {
    method: "POST",
    body: JSON.stringify({ p_order: orderId, p_amount: amount, p_provider_ref: ref || null }),
  });
  return r.ok ? r.json() : `db_error_${r.status}`;
}
export async function markFailed(orderId) {
  await sbService("/rest/v1/rpc/mark_order_failed", { method: "POST", body: JSON.stringify({ p_order: orderId }) });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
