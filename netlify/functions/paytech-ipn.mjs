// POST /api/webhooks/paytech — notification de paiement PayTech (Orange Money)
// Vérification recommandée par PayTech : hmac_compute = HMAC-SHA256(api_secret, "montant|ref_command|api_key")
import { env, json, hmacHex, sha256Hex, safeEq, markPaid, markFailed, UUID_RE } from "../lib/common.mjs";

function parseBody(raw, type) {
  if ((type || "").includes("application/json")) { try { return JSON.parse(raw); } catch { return null; } }
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

export function verifyPaytech(p, key, secret) {
  if (!p || !key || !secret) return false;
  if (p.hmac_compute) {
    const amounts = [p.final_item_price, p.item_price].filter((a) => a !== undefined && a !== null && a !== "");
    return amounts.some((a) => safeEq(String(p.hmac_compute).toLowerCase(), hmacHex(secret, `${a}|${p.ref_command}|${key}`)));
  }
  // Méthode de secours (moins sûre) prévue par PayTech
  return safeEq(p.api_key_sha256, sha256Hex(key)) && safeEq(p.api_secret_sha256, sha256Hex(secret));
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  const raw = await req.text();
  if (raw.length > 100000) return json({ error: "trop volumineux" }, 413);
  const p = parseBody(raw, req.headers.get("content-type"));
  if (!verifyPaytech(p, env("PAYTECH_API_KEY"), env("PAYTECH_API_SECRET"))) {
    console.warn("paytech_bad_signature");
    return json({ error: "Signature invalide." }, 401);
  }
  const orderId = p.ref_command;
  if (!UUID_RE.test(orderId || "")) return json({ ignored: true });
  // Refuser une notification de test quand le site est en production
  if (env("PAYTECH_ENV") === "prod" && p.env && p.env !== "prod") return json({ ignored: "test" });

  try {
    if (p.type_event === "sale_complete") {
      const res = await markPaid(orderId, Math.round(Number(p.item_price)), p.token);
      console.log("paytech_paid", res);
    } else if (p.type_event === "sale_canceled") {
      await markFailed(orderId);
    }
    return json({ received: true });
  } catch (e) {
    console.error("paytech_ipn_error", e?.name);
    return json({ error: "Réessayer plus tard." }, 500);
  }
};
export const config = { path: "/api/webhooks/paytech" };
