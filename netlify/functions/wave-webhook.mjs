// POST /api/webhooks/wave — notifications Wave, signées (en-tête Wave-Signature : t=<horodatage>,v1=<hmac>)
import { env, json, hmacHex, safeEq, markPaid, markFailed, UUID_RE } from "../lib/common.mjs";

const TOLERANCE = 300; // secondes : au-delà, on refuse (protection contre le rejeu)

export function verifyWave(header, raw, secret, now = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now - Number(t)) > TOLERANCE) return false;
  const expected = hmacHex(secret, `${t}${raw}`);
  return sigs.some((s) => safeEq(s.toLowerCase(), expected));
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  const raw = await req.text(); // corps brut : ne surtout pas le reformater avant la vérification
  if (raw.length > 100000) return json({ error: "trop volumineux" }, 413);
  if (!verifyWave(req.headers.get("wave-signature"), raw, env("WAVE_WEBHOOK_SECRET"))) {
    console.warn("wave_bad_signature");
    return json({ error: "Signature invalide." }, 401);
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ error: "JSON invalide." }, 400); }
  const d = ev?.data || {};
  const orderId = d.client_reference;
  if (!UUID_RE.test(orderId || "")) return json({ ignored: true }); // paiement sans lien avec Parole

  try {
    if (ev.type === "checkout.session.completed" && d.payment_status === "succeeded" && d.currency === "XOF") {
      const res = await markPaid(orderId, Number(d.amount), d.id);
      console.log("wave_paid", res);
    } else if (ev.type === "checkout.session.payment_failed") {
      await markFailed(orderId);
    }
    return json({ received: true });
  } catch (e) {
    console.error("wave_webhook_error", e?.name);
    return json({ error: "Réessayer plus tard." }, 500); // Wave renverra la notification
  }
};
export const config = { path: "/api/webhooks/wave" };
