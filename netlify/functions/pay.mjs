// POST /api/pay  {plan, method}  → crée la commande et renvoie l'URL de paiement (Wave ou Orange Money via PayTech)
// GET  /api/pay?order=<id>       → statut de la commande (avec rapprochement Wave si le webhook n'est pas encore arrivé)
import { env, json, siteUrl, sbUser, sbService, bearer, getUser, originOk, markPaid, markFailed, hmacHex, UUID_RE } from "../lib/common.mjs";

const PLANS = new Set(["mois", "trimestre", "annee"]);
const METHODS = new Set(["wave", "orange_money"]);

async function waveFetch(path, init = {}) {
  const body = init.body || "";
  const headers = { authorization: `Bearer ${env("WAVE_API_KEY")}`, "content-type": "application/json" };
  const secret = env("WAVE_SIGNING_SECRET"); // seulement si la signature des requêtes est activée sur la clé
  if (secret) {
    const t = Math.floor(Date.now() / 1000);
    headers["wave-signature"] = `t=${t},v1=${hmacHex(secret, `${t}${body}`)}`;
  }
  return fetch(`https://api.wave.com${path}`, { ...init, headers, signal: AbortSignal.timeout(8000) });
}

async function createPayment(req) {
  if (!originOk(req)) return json({ error: "Origine refusée." }, 403);
  const token = bearer(req);
  const user = await getUser(token);
  if (!user) return json({ error: "Connectez-vous pour vous abonner." }, 401);

  const { plan, method } = await req.json().catch(() => ({}));
  if (!PLANS.has(plan) || !METHODS.has(method)) return json({ error: "Offre ou moyen de paiement inconnu." }, 400);
  if (method === "wave" && !env("WAVE_API_KEY")) return json({ error: "Le paiement Wave n’est pas encore activé." }, 503);
  if (method === "orange_money" && !(env("PAYTECH_API_KEY") && env("PAYTECH_API_SECRET")))
    return json({ error: "Le paiement Orange Money n’est pas encore activé." }, 503);

  // Le prix est fixé dans la base (table plans) : le navigateur n'envoie jamais de montant.
  const o = await sbUser("/rest/v1/rpc/create_order", token, { method: "POST", body: JSON.stringify({ p_plan: plan, p_method: method }) });
  if (!o.ok) {
    const e = await o.json().catch(() => ({}));
    if (String(e.message || "").includes("too many")) return json({ error: "Trop de tentatives de paiement. Réessayez dans une heure." }, 429);
    return json({ error: "Commande impossible. Réessayez." }, 400);
  }
  const order = await o.json();
  const back = `${siteUrl()}/#/paiement/${order.id}`;

  try {
    if (method === "wave") {
      const r = await waveFetch("/v1/checkout/sessions", {
        method: "POST",
        body: JSON.stringify({ amount: String(order.amount), currency: "XOF", client_reference: order.id, success_url: back, error_url: `${back}/echec` }),
      });
      if (!r.ok) { console.error("wave_create", r.status); await markFailed(order.id); return json({ error: "Wave est indisponible. Réessayez." }, 502); }
      const s = await r.json();
      await sbService(`/rest/v1/orders?id=eq.${order.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ provider_ref: s.id }) });
      return json({ url: s.wave_launch_url, order: order.id });
    }

    const r = await fetch("https://paytech.sn/api/payment/request-payment", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { API_KEY: env("PAYTECH_API_KEY"), API_SECRET: env("PAYTECH_API_SECRET"), "content-type": "application/json" },
      body: JSON.stringify({
        item_name: `Parole — abonnement ${order.label}`,
        item_price: order.amount,
        currency: "XOF",
        ref_command: order.id,
        command_name: `Abonnement Parole ${order.label}`,
        env: env("PAYTECH_ENV") === "prod" ? "prod" : "test",
        ipn_url: `${siteUrl()}/api/webhooks/paytech`,
        success_url: back,
        cancel_url: `${back}/echec`,
        target_payment: "Orange Money",
        custom_field: JSON.stringify({ order: order.id }),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || Number(d.success) !== 1 || !d.redirect_url) {
      console.error("paytech_create", r.status);
      await markFailed(order.id);
      return json({ error: "Orange Money est indisponible. Réessayez." }, 502);
    }
    if (d.token)
      await sbService(`/rest/v1/orders?id=eq.${order.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ provider_ref: d.token }) });
    return json({ url: d.redirect_url, order: order.id });
  } catch (e) {
    console.error("pay_error", e?.name);
    await markFailed(order.id).catch(() => {});
    return json({ error: "Le service de paiement ne répond pas. Réessayez." }, 504);
  }
}

async function orderStatus(req) {
  const id = new URL(req.url).searchParams.get("order") || "";
  if (!UUID_RE.test(id)) return json({ error: "Commande inconnue." }, 400);
  const token = bearer(req);
  // Lecture avec le jeton de l'utilisateur : il ne voit que ses propres commandes.
  const r = await sbUser(`/rest/v1/orders?id=eq.${id}&select=id,status,provider,provider_ref,amount,plan_id`, token);
  const [o] = r.ok ? await r.json() : [];
  if (!o) return json({ error: "Commande introuvable." }, 404);

  // Rapprochement : si Wave dit « payé » mais que le webhook n'est pas encore arrivé
  if (o.status === "pending" && o.provider === "wave" && o.provider_ref && env("WAVE_API_KEY")) {
    try {
      const s = await (await waveFetch(`/v1/checkout/sessions/${encodeURIComponent(o.provider_ref)}`)).json();
      if (s.client_reference === o.id && s.payment_status === "succeeded" && s.checkout_status === "complete" && s.currency === "XOF") {
        const res = await markPaid(o.id, Number(s.amount), s.id);
        if (res === "paid" || res === "already_paid") o.status = "paid";
      } else if (s.checkout_status === "expired") {
        await markFailed(o.id); o.status = "failed";
      }
    } catch { /* on garde le statut actuel */ }
  }
  return json({ status: o.status });
}

export default async (req) => {
  try {
    if (req.method === "POST") return await createPayment(req);
    if (req.method === "GET") return await orderStatus(req);
    return json({ error: "Méthode non autorisée." }, 405);
  } catch (e) {
    console.error("pay_fatal", e?.name);
    return json({ error: "Erreur inattendue." }, 500);
  }
};
export const config = { path: "/api/pay" };
