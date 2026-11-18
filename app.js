"use strict";
// Parole — application (catalogue, leçons, coach, abonnement). Tout le contenu vient de Supabase.
const $=s=>document.querySelector(s),app=$("#app");
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sb=supabase.createClient(CFG.url,CFG.anon,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
let user=null,done=new Set(),recovering=false,cat=null,isAdmin=false,access={premium:false,until:null},timer=null;
const SITE=location.origin+location.pathname;
const fcfa=n=>new Intl.NumberFormat("fr-FR").format(n)+" FCFA";
const dateFr=d=>new Date(d).toLocaleDateString("fr-FR",{day:"numeric",month:"long",year:"numeric"});
const WPM=130;
// Affichage sûr du retour : tout est échappé, seul **gras** devient du gras.
const fbHtml=t=>esc(t).replace(/\*\*([^*\n]{1,120})\*\*/g,"<strong>$1</strong>").replace(/^#{1,4}\s*/gm,"");
const SUBJECTS=["Le meilleur conseil qu’on vous ait donné","Dakar dans dix ans","La teranga a-t-elle sa place en entreprise ?","Faut-il interdire le téléphone à l’école ?","Votre plus belle erreur","Entreprendre jeune : chance ou risque ?","Le télétravail est-il une bonne idée ?","Faut-il prêter de l’argent à ses amis ?","L’intelligence artificielle remplacera-t-elle les enseignants ?","La ponctualité est-elle une politesse ?","Un livre ou un film qui vous a changé","Pourquoi tout le monde devrait apprendre à parler en public","L’argent fait-il le bonheur ?","Les réseaux sociaux nous rapprochent-ils ?","Le métier dont vous rêviez enfant","Ce que vous changeriez dans votre quartier","Faut-il travailler le samedi ?","Le sport le plus utile dans la vie","Une tradition que vous aimeriez transmettre","Réussir, c’est quoi pour vous ?"];

async function boot(){
 const hp=new URLSearchParams(location.hash.slice(1)),qp=new URLSearchParams(location.search);
 const linkErr=hp.get("error_description")||qp.get("error_description");
 if(location.hash.includes("type=recovery"))recovering=true;
 const {data}=await sb.auth.getSession();user=data.session?.user||null;
 // Ne jamais appeler Supabase directement dans ce callback (blocage connu de supabase-js) : on diffère avec setTimeout.
 sb.auth.onAuthStateChange((ev,s)=>{const was=user?.id;user=s?.user||null;if(ev==="PASSWORD_RECOVERY")recovering=true;
  if(ev==="INITIAL_SESSION"||ev==="TOKEN_REFRESHED")return;if(was!==user?.id)cat=null;setTimeout(route,0)});
 if(/access_token|error_description|type=/.test(location.hash))history.replaceState(null,"",location.pathname+"#/");
 if(linkErr&&!user)return authView("login","Lien invalide ou expiré. Reconnectez-vous ou demandez un nouveau lien.");
 await route();
}
addEventListener("hashchange",()=>{stopTimer();route()});

function skeleton(){app.innerHTML=`<div class="hero"><div class="sk" style="height:64px;width:60%"></div><div class="sk" style="height:18px;width:40%;margin-top:16px"></div></div>${'<div class="sk" style="height:120px;margin:12px 0"></div>'.repeat(3)}`}

// Chargement du catalogue, de l'abonnement et de la progression, en parallèle et une seule fois.
async function loadAll(force=false){
 if(cat&&!force)return;
 const [m,l,a,p,ad]=await Promise.all([
  sb.from("modules").select("id,name,intro,color,position").order("position"),
  sb.from("lessons").select("id,module_id,position,title,premium,duration_sec").order("position"),
  sb.rpc("my_access"),
  sb.from("progress").select("lesson_id"),
  sb.rpc("is_admin")]);
 if(m.error||l.error)throw m.error||l.error;
 const mods=m.data.map(x=>({...x,lessons:l.data.filter(y=>y.module_id===x.id)}));
 cat={mods,les:Object.fromEntries(l.data.map(y=>[y.id,{...y,m:mods.find(x=>x.id===y.module_id)}]))};
 access=a.data||{premium:false};isAdmin=ad.data===true;done=new Set((p.data||[]).map(r=>r.lesson_id));
}
const locked=l=>l.premium&&!access.premium;

function renderWho(){
 $("#who").innerHTML=user?`${isAdmin?'<a class="pill adm" href="#/admin">Admin</a>':""}${access.premium?'<span class="pill">Premium</span>':`<a class="pill up" href="#/premium">Passer en premium</a>`} <button class="alt" id="out">Se déconnecter</button>`:"";
 if(user)$("#out").onclick=()=>{cat=null;isAdmin=false;access={premium:false};sb.auth.signOut()};
}
async function route(){
 renderWho();
 const [,k,id,extra]=location.hash.split("/");
 if(!user&&k==="premium")return pricingView();
 if(user&&recovering)return newPasswordView();
 if(!user)return authView();
 if(!cat)skeleton();
 try{await loadAll()}catch(e){app.innerHTML=`<p class="err">Impossible de charger les leçons. Vérifiez votre connexion puis rechargez la page.</p>`;return}
 renderWho();
 if(k==="admin")return adminView();
 if(k==="l"&&cat.les[id])return lessonView(cat.les[id]);
 if(k==="premium")return pricingView();
 if(k==="paiement"&&id)return paymentReturnView(id,extra==="echec");
 if(k){location.hash="#/";return}
 home();
}

function errMsg(e,ctx){const m=(e?.message||"").toLowerCase(),c=e?.code||"",st=e?.status;
 if(c==="email_not_confirmed"||m.includes("not confirmed"))return "Adresse e-mail non confirmée. Ouvrez le lien reçu par e-mail (pensez aux spams), puis connectez-vous.";
 if(c==="invalid_credentials"||m.includes("invalid login"))return "E-mail ou mot de passe incorrect.";
 if(c==="user_already_exists"||m.includes("already registered"))return "Un compte existe déjà avec cet e-mail. Connectez-vous ou utilisez « Mot de passe oublié ».";
 if(c==="weak_password"||m.includes("password should"))return "Mot de passe trop faible : 8 caractères minimum, avec lettres et chiffres.";
 if(c==="email_address_invalid"||m.includes("invalid format")||m.includes("is invalid"))return "Adresse e-mail invalide.";
 if(c==="email_address_not_authorized"||m.includes("not authorized"))return "L’envoi d’e-mails n’est pas encore configuré sur le serveur (SMTP). L’administrateur doit le régler dans Supabase.";
 if(c==="signup_disabled"||m.includes("signups not allowed"))return "Les inscriptions sont fermées pour le moment.";
 if(c==="over_email_send_rate_limit"||c==="over_request_rate_limit"||m.includes("rate limit")||st===429)return "Trop de tentatives. Patientez quelques minutes avant de réessayer.";
 if(m.includes("api key")||st===401)return "Configuration du site invalide (clé Supabase). L’administrateur doit vérifier config.js.";
 if(m.includes("failed to fetch")||m.includes("network"))return "Impossible de joindre le serveur. Vérifiez votre connexion internet.";
 console.warn("auth",c||st);
 return (ctx==="signup"?"Inscription impossible. ":"Connexion impossible. ")+"Réessayez dans un instant."}
const pwOk=p=>p.length>=8&&/[a-zA-Z]/.test(p)&&/\d/.test(p);
function authView(mode="login",msg="",email="",ok=false){
 const T={login:["Se connecter","Pas encore de compte ? Créer un compte","signup"],signup:["Créer mon compte","Déjà inscrit ? Se connecter","login"],reset:["Recevoir le lien","Retour à la connexion","login"]}[mode];
 app.innerHTML=`<div class="hero"><h1>Parlez pour être entendu.</h1><p>25 leçons, des mises en situation, des défis chronométrés et un coach IA qui commente chacun de vos textes. Commencez gratuitement. <a href=\"#/premium\">Voir les offres</a></p></div>
 <form class="box" id="f" novalidate><h2>${mode==="signup"?"Créer un compte":mode==="reset"?"Mot de passe oublié":"Connexion"}</h2>
 <label>Adresse e-mail<input type="email" id="em" required autocomplete="email" inputmode="email" maxlength="254" value="${esc(email)}"></label>
 ${mode==="reset"?"":`<label>Mot de passe${mode==="signup"?" (8 caractères min., lettres et chiffres)":""}<input type="password" id="pw" minlength="8" maxlength="72" required autocomplete="${mode==="signup"?"new-password":"current-password"}"></label>
 <label style="display:flex;gap:8px;align-items:center;font-size:15px"><input type="checkbox" id="show" style="width:auto"> Afficher le mot de passe</label>`}
 <p class="${ok?"okm":"err"}" role="alert" id="msg">${esc(msg)}</p>
 <button type="submit" id="go">${T[0]}</button>
 <div class="row" style="justify-content:space-between"><button type="button" class="link" id="sw">${T[1]}</button>
 ${mode==="login"?`<button type="button" class="link" id="fg">Mot de passe oublié ?</button>`:""}</div></form>`;
 $("#sw").onclick=()=>authView(T[2],"",$("#em").value);
 if($("#fg"))$("#fg").onclick=()=>authView("reset","",$("#em").value);
 if($("#show"))$("#show").onchange=e=>$("#pw").type=e.target.checked?"text":"password";
 const say=(t,good=false)=>{const el=$("#msg");el.className=good?"okm":"err";el.textContent=t};
 $("#f").onsubmit=async e=>{e.preventDefault();
  const email=$("#em").value.trim().toLowerCase(),password=$("#pw")?.value||"";
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return say("Adresse e-mail invalide.");
  if(mode!=="reset"&&mode==="signup"&&!pwOk(password))return say("Mot de passe trop faible : 8 caractères minimum, avec lettres et chiffres.");
  if(mode==="login"&&!password)return say("Saisissez votre mot de passe.");
  const b=$("#go"),lbl=b.textContent;b.disabled=true;b.textContent="Patientez…";say("");
  try{
   if(mode==="login"){const {error}=await sb.auth.signInWithPassword({email,password});if(error)return say(errMsg(error,"login"))}
   else if(mode==="signup"){
    const {data,error}=await sb.auth.signUp({email,password,options:{emailRedirectTo:SITE}});
    if(error)return say(errMsg(error,"signup"));
    // Supabase renvoie un utilisateur sans identité quand l'e-mail existe déjà (protection anti-énumération)
    if(data.user&&Array.isArray(data.user.identities)&&data.user.identities.length===0)return say("Un compte existe déjà avec cet e-mail. Connectez-vous ou utilisez « Mot de passe oublié ».");
    if(!data.session)return authView("login","Compte créé ✔ Un e-mail de confirmation vient d’être envoyé à "+email+". Cliquez le lien (vérifiez les spams), puis connectez-vous ici.",email,true);
   }else{
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:SITE});
    if(error)return say(errMsg(error,"reset"));
    return say("Si un compte existe pour cet e-mail, un lien de réinitialisation vient d’être envoyé.",true);
   }
  }catch(err){say(errMsg(err,mode))}
  finally{if(document.body.contains(b)){b.disabled=false;b.textContent=lbl}}
 };
}
function newPasswordView(){
 app.innerHTML=`<form class="box" id="np"><h2>Nouveau mot de passe</h2>
 <label>Nouveau mot de passe (8 caractères min., lettres et chiffres)<input type="password" id="pw" minlength="8" maxlength="72" required autocomplete="new-password"></label>
 <p class="err" role="alert" id="msg"></p><button type="submit">Enregistrer</button></form>`;
 $("#np").onsubmit=async e=>{e.preventDefault();const p=$("#pw").value;
  if(!pwOk(p)){$("#msg").textContent="Mot de passe trop faible.";return}
  const {error}=await sb.auth.updateUser({password:p});
  if(error){$("#msg").textContent=errMsg(error,"reset");return}
  recovering=false;route()};
}

function home(){
 const st=access.premium?`<p class="okm">Premium actif jusqu’au ${esc(dateFr(access.until))}.</p>`
  :`<p>Vous êtes en accès gratuit : la première leçon de chaque module et 3 retours du coach par jour. <a href="#/premium">Débloquer les ${Object.values(cat.les).filter(l=>l.premium).length} autres leçons</a>.</p>`;
 app.innerHTML=`<div class="hero"><h1>Votre parcours</h1><p>${cat.mods.length} axes de travail, ${Object.keys(cat.les).length} leçons. Commencez par celui qui vous manque le plus.</p>${st}</div>`+
 cat.mods.map(m=>{const n=m.lessons.filter(l=>done.has(l.id)).length,next=m.lessons.find(l=>!done.has(l.id)&&!locked(l))||m.lessons[0];
  return `<section style="background:${m.color}"><a class="band" href="#/l/${esc(next.id)}"><h2>${esc(m.name)}</h2><span>${esc(m.intro)} ${n}/${m.lessons.length} terminées.</span></a></section>`}).join("")+
 `<div style="margin-top:32px">`+cat.mods.map(m=>`<h3 style="margin:28px 0 4px;color:${m.color}">${esc(m.name)}</h3><div class="lesson-list" style="--c:${m.color}">`+
  m.lessons.map(l=>`<a href="#/l/${esc(l.id)}"><span>${esc(l.title)}${l.duration_sec?` <small class="mut">· ${fmt(l.duration_sec)}</small>`:""}</span><span>${locked(l)?"🔒 Premium":done.has(l.id)?"Terminée":"À faire"}</span></a>`).join("")+`</div>`).join("")+`</div>`;
}

const fmt=s=>`${Math.floor(s/60)}:${String(Math.round(s)%60).padStart(2,"0")}`;
function stopTimer(){if(timer){clearInterval(timer.h);timer=null}}

async function lessonView(l){
 const head=`<p><a class="crumb" href="#/">← Retour au parcours</a></p><p class="mut" style="margin:0">${esc(l.m.name)}</p>
 <h1 style="font-size:clamp(34px,6vw,56px);color:${l.m.color}">${esc(l.title)}</h1>`;
 if(locked(l)){
  app.innerHTML=`${head}<div class="prose" style="--c:${l.m.color}"><p class="task">Cette leçon fait partie de l’offre Premium.</p>
  <p>Avec Premium : les ${Object.values(cat.les).filter(x=>x.premium).length} leçons premium, les mises en situation et défis chronométrés, et 15 retours du coach par jour. Paiement par Wave ou Orange Money.</p>
  <p><a class="btn" href="#/premium">Voir les offres</a></p></div>`;return;
 }
 app.innerHTML=head+`<div class="sk" style="height:140px"></div>`;
 const [c,last]=await Promise.all([
  sb.from("lesson_content").select("body,task").eq("lesson_id",l.id).maybeSingle(),
  sb.from("submissions").select("body,feedback").eq("lesson_id",l.id).order("created_at",{ascending:false}).limit(1)]);
 if(!c.data){app.innerHTML=head+`<p class="err">Contenu indisponible. Rechargez la page.</p>`;return}
 const p=last.data?.[0],dur=l.duration_sec;
 app.innerHTML=`${head}<div style="--c:${l.m.color}">
 <div class="prose">${c.data.body.map(t=>`<p>${esc(t)}</p>`).join("")}</div>
 <p class="task prose">${esc(c.data.task)}</p>
 ${l.module_id==="d"?`<div class="row"><button class="alt" id="draw">🎲 Tirer un sujet</button></div><p class="subject" id="subj" hidden></p>`:""}
 ${dur?`<div class="timer" id="tm"><span id="tv">0:00</span> / ${fmt(dur)}<button class="alt" id="tgo">▶ Démarrer</button><button class="alt" id="trs">↺</button></div>`:""}
 <label class="prose" style="display:block">Votre texte<textarea id="tx" maxlength="4000" placeholder="Écrivez comme vous parleriez…">${esc(p?.body||"")}</textarea></label>
 <p class="mut" id="wc"></p>
 <p class="err" id="er" role="alert"></p>
 <div class="row"><button id="ask">Demander un retour au coach</button><button class="alt" id="ok">${done.has(l.id)?"Leçon terminée ✔":"Marquer comme terminée"}</button></div>
 <div class="fb" id="fb" ${p?.feedback?"":"hidden"}>${fbHtml(p?.feedback||"")}</div></div>`;

 const wc=()=>{const n=$("#tx").value.trim().split(/\s+/).filter(Boolean).length,est=Math.round(n/WPM*60);
  $("#wc").textContent=n?`${n} mots · environ ${fmt(est)} à l’oral`+(dur?(est>dur*1.15?" — trop long pour la durée cible":est<dur*.6?" — un peu court":" — dans le temps ✔"):""):""};
 $("#tx").oninput=wc;wc();
 if($("#draw"))$("#draw").onclick=()=>{const s=$("#subj");s.hidden=false;s.textContent="Sujet : "+SUBJECTS[Math.floor(Math.random()*SUBJECTS.length)]};
 if(dur){
  const show=()=>{const t=timer?timer.acc+(timer.run?(Date.now()-timer.t0)/1000:0):0;$("#tv").textContent=fmt(t);$("#tm").classList.toggle("over",t>dur);return t};
  timer={acc:0,run:false,t0:0,h:setInterval(()=>{if(document.body.contains($("#tv")))show()},250)};
  $("#tgo").onclick=()=>{if(timer.run){timer.acc+=(Date.now()-timer.t0)/1000;timer.run=false;$("#tgo").textContent="▶ Reprendre"}else{timer.t0=Date.now();timer.run=true;$("#tgo").textContent="⏸ Pause"}};
  $("#trs").onclick=()=>{timer.acc=0;timer.run=false;$("#tgo").textContent="▶ Démarrer";show()};
 }
 $("#ask").onclick=async()=>{
  const text=$("#tx").value.trim(),b=$("#ask");$("#er").textContent="";
  if(text.length<20){$("#er").textContent="Écrivez au moins 20 caractères.";return}
  b.disabled=true;b.textContent="Le coach lit votre texte…";
  const seconds=timer?Math.round(timer.acc+(timer.run?(Date.now()-timer.t0)/1000:0)):undefined;
  try{
   const {data:{session}}=await sb.auth.getSession();
   if(!session)throw new Error("Session expirée. Reconnectez-vous.");
   const r=await fetch("/api/coach",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+session.access_token},body:JSON.stringify({lesson:l.id,text,seconds})});
   if(!r.ok||!(r.headers.get("content-type")||"").startsWith("text/plain")){
    const d=await r.json().catch(()=>({error:"Le coach est indisponible (service non déployé ?)."}));
    if(d.upgrade){$("#er").innerHTML=esc(d.error)+' <a href="#/premium">Voir les offres</a>';return}
    throw new Error(d.error||"Erreur")}
   // Lecture au fil de l'eau : le retour s'affiche pendant que le coach l'écrit
   const fb=$("#fb"),rd=r.body.getReader(),dec=new TextDecoder();let txt="";
   fb.hidden=false;fb.textContent="";fb.classList.add("live");b.textContent="Le coach écrit…";
   for(;;){const {value,done:end}=await rd.read();if(end)break;txt+=dec.decode(value,{stream:true});if(document.body.contains(fb))fb.textContent=txt}
   fb.classList.remove("live");fb.innerHTML=fbHtml(txt);
   const rem=r.headers.get("x-remaining");if(rem!==null&&rem!==""&&!txt.includes("[Le coach a été interrompu"))fb.innerHTML=fbHtml(txt+`\n\n— Retours restants aujourd’hui : ${rem}`);
  }catch(e){$("#er").textContent=e.message}
  finally{b.disabled=false;b.textContent="Demander un retour au coach"}
 };
 $("#ok").onclick=async()=>{
  const {error}=await sb.from("progress").upsert({user_id:user.id,lesson_id:l.id},{onConflict:"user_id,lesson_id",ignoreDuplicates:true});
  if(error){$("#er").textContent="Enregistrement impossible. Réessayez.";return}
  done.add(l.id);$("#ok").textContent="Leçon terminée ✔";
 };
}

async function pricingView(){
 app.innerHTML=`<p><a class="crumb" href="#/">← Retour</a></p><div class="hero"><h1>Premium</h1><p>Toutes les leçons, les mises en situation, les défis chronométrés et 15 retours du coach par jour.</p></div><div class="sk" style="height:160px"></div>`;
 const {data:plans,error}=await sb.from("plans").select("id,label,amount,days").order("position");
 if(error||!plans?.length){app.querySelector(".sk").outerHTML=`<p class="err">Offres indisponibles pour le moment.</p>`;return}
 const per=p=>Math.round(p.amount/Math.max(1,Math.round(p.days/30.4)));
 app.querySelector(".sk").outerHTML=`${access.premium?`<p class="okm">Votre Premium est actif jusqu’au ${esc(dateFr(access.until))}. Un nouvel achat prolonge cette date.</p>`:""}
 <form id="pf" class="plans">${plans.map((p,i)=>`<label class="plan"><input type="radio" name="plan" value="${esc(p.id)}" ${i===1?"checked":""}>
  <strong>${esc(p.label)}</strong><span class="price">${fcfa(p.amount)}</span><small class="mut">soit ${fcfa(per(p))} / mois</small></label>`).join("")}
 <fieldset class="pay"><legend>Moyen de paiement</legend>
  <label><input type="radio" name="m" value="wave" checked> Wave</label>
  <label><input type="radio" name="m" value="orange_money"> Orange Money</label></fieldset>
 <p class="err" id="per" role="alert"></p>
 <button type="submit" id="pgo">${user?"Payer":"Créer un compte pour s’abonner"}</button>
 <p class="mut" style="font-size:14px">Paiement unique, sans renouvellement automatique. Le prix affiché est le prix payé.</p></form>`;
 $("#pf").onsubmit=async e=>{e.preventDefault();
  if(!user){location.hash="#/";return authView("signup","Créez votre compte, puis revenez sur « Passer en premium ».")}
  const f=new FormData(e.target),b=$("#pgo");b.disabled=true;b.textContent="Redirection vers le paiement…";$("#per").textContent="";
  try{
   const {data:{session}}=await sb.auth.getSession();
   const r=await fetch("/api/pay",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+session.access_token},body:JSON.stringify({plan:f.get("plan"),method:f.get("m")})});
   const d=await r.json().catch(()=>({error:"Service de paiement indisponible."}));
   if(!r.ok||!d.url)throw new Error(d.error||"Paiement impossible.");
   location.href=d.url;
  }catch(err){$("#per").textContent=err.message;b.disabled=false;b.textContent="Payer"}
 };
}

async function paymentReturnView(orderId,failed){
 if(failed){app.innerHTML=`<div class="hero"><h1>Paiement non abouti</h1><p>Aucun montant n’a été validé. Vous pouvez réessayer.</p><p><a class="btn" href="#/premium">Revenir aux offres</a></p></div>`;return}
 app.innerHTML=`<div class="hero"><h1>Vérification du paiement…</h1><p id="ps">Nous attendons la confirmation de l’opérateur. Ne fermez pas cette page.</p></div>`;
 const {data:{session}}=await sb.auth.getSession();
 for(let i=0;i<40;i++){
  if(!location.hash.startsWith("#/paiement/"))return;
  const r=await fetch("/api/pay?order="+encodeURIComponent(orderId),{headers:{authorization:"Bearer "+session.access_token}}).catch(()=>null);
  const d=r?await r.json().catch(()=>({})):{};
  if(d.status==="paid"){await loadAll(true);
   app.innerHTML=`<div class="hero"><h1>Bienvenue en Premium 🎉</h1><p class="okm">Accès actif jusqu’au ${esc(dateFr(access.until))}.</p><p><a class="btn" href="#/">Commencer</a></p></div>`;renderWho();return}
  if(d.status==="failed"||d.status==="expired")return paymentReturnView(orderId,true);
  if(d.error&&r?.status===404)break;
  await new Promise(res=>setTimeout(res,3000));
 }
 $("#ps").innerHTML=`La confirmation prend plus de temps que prévu. Si vous avez été débité, votre accès sera activé automatiquement dès réception : rechargez cette page dans quelques minutes. <a href="#/">Retour au parcours</a>`;
}


// ───────── Espace administrateur (#/admin). L'écran n'est qu'une vitrine : chaque donnée est refusée par la base si l'on n'est pas admin.
const tile=(k,v)=>`<div class="tile"><span class="mut">${esc(k)}</span><strong>${esc(v)}</strong></div>`;
const dt=d=>d?new Date(d).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"2-digit"}):"—";
const ST={paid:"Payée",pending:"En attente",failed:"Échouée",expired:"Expirée"},MT={wave:"Wave",orange_money:"Orange Money"};
async function adminView(){
 if(!isAdmin){location.hash="#/";return}
 app.innerHTML=`<p><a class="crumb" href="#/">← Retour au parcours</a></p><div class="hero"><h1>Administration</h1></div>
 <div class="tiles" id="tiles">${'<div class="sk" style="height:84px"></div>'.repeat(8)}</div>
 <h2 class="h2">Offrir ou retirer le Premium</h2>
 <form id="gp" class="row" style="align-items:end;max-width:760px">
  <label style="flex:2;min-width:220px">E-mail de l’apprenant<input type="email" id="gpe" required maxlength="254"></label>
  <label style="flex:1;min-width:150px">Durée<select id="gpd"><option value="30">1 mois</option><option value="90">3 mois</option><option value="365">12 mois</option><option value="0">Retirer l’accès</option></select></label>
  <button type="submit" id="gpb">Appliquer</button></form><p id="gpm" role="status"></p>
 <h2 class="h2">Apprenants</h2>
 <input type="search" id="q" placeholder="Rechercher un e-mail…" style="max-width:360px" maxlength="100">
 <div id="lt"><div class="sk" style="height:200px;margin-top:12px"></div></div>
 <h2 class="h2">Dernières commandes</h2><div id="ot"><div class="sk" style="height:160px"></div></div>`;
 let page=0,qv="",deb=null;const PER=20;
 const fail=el=>{$(el).innerHTML=`<p class="err">Chargement impossible.</p>`};
 const loadLearners=async()=>{
  const {data,error}=await sb.rpc("admin_learners",{p_search:qv,p_limit:PER,p_offset:page*PER});
  if(error)return fail("#lt");
  const pages=Math.max(1,Math.ceil(data.total/PER));
  $("#lt").innerHTML=`<div class="tbl"><table><thead><tr><th>E-mail</th><th>Inscrit</th><th>Premium</th><th>Leçons</th><th>Textes</th><th>Dernier texte</th></tr></thead><tbody>${
   data.rows.map(r=>`<tr><td>${esc(r.email)}${r.confirmed?"":' <small class="err">non confirmé</small>'}</td><td>${dt(r.created_at)}</td>
   <td>${r.access_until&&new Date(r.access_until)>new Date()?"jusqu’au "+dt(r.access_until):"—"}</td><td>${r.lessons_done}</td><td>${r.texts}</td><td>${dt(r.last_text)}</td></tr>`).join("")||'<tr><td colspan="6">Aucun résultat.</td></tr>'
  }</tbody></table></div><div class="row" style="align-items:center"><button class="alt" id="pv" ${page?"":"disabled"}>←</button><span>${page+1} / ${pages} · ${data.total} apprenant(s)</span><button class="alt" id="nx" ${page+1<pages?"":"disabled"}>→</button></div>`;
  $("#pv").onclick=()=>{page--;loadLearners()};$("#nx").onclick=()=>{page++;loadLearners()};
 };
 // Les trois blocs se chargent en parallèle
 const ov=sb.rpc("admin_overview").then(({data:o,error})=>{if(error)return fail("#tiles");
  $("#tiles").innerHTML=[tile("Apprenants",o.users),tile("Nouveaux (7 j)",o.users_7d),tile("Premium actifs",o.premium),tile("Revenus du mois",fcfa(o.revenue_month)),
   tile("Revenus totaux",fcfa(o.revenue_total)),tile("Paiements en attente (24 h)",o.pending),tile("Textes envoyés (7 j)",o.texts_7d),tile("Retours du coach aujourd’hui",o.coach_today+" / 300")].join("")+
   (o.top_lessons.length?`<div class="tile wide"><span class="mut">Leçons les plus terminées</span>${o.top_lessons.map(t=>`<div>${esc(t.title)} — ${t.done}</div>`).join("")}</div>`:"")});
 const od=sb.rpc("admin_orders",{p_limit:20,p_offset:0}).then(({data,error})=>{if(error)return fail("#ot");
  $("#ot").innerHTML=data.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>E-mail</th><th>Offre</th><th>Montant</th><th>Moyen</th><th>Statut</th></tr></thead><tbody>${
   data.map(o=>`<tr><td>${dt(o.created_at)}</td><td>${esc(o.email)}</td><td>${esc(o.plan)}</td><td>${fcfa(o.amount)}</td><td>${esc(MT[o.method]||o.method)}</td><td class="st-${esc(o.status)}">${esc(ST[o.status]||o.status)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="mut">Aucune commande pour l’instant.</p>`});
 await Promise.all([ov,od,loadLearners()]);
 $("#q").oninput=e=>{clearTimeout(deb);deb=setTimeout(()=>{qv=e.target.value.trim();page=0;loadLearners()},300)}; // attente de la fin de frappe
 let armed=false;
 $("#gp").onsubmit=async e=>{e.preventDefault();const b=$("#gpb"),em=$("#gpe").value.trim(),d=Number($("#gpd").value);
  if(!armed){armed=true;b.textContent=d?`Confirmer : ${$("#gpd").selectedOptions[0].text} pour ${em}`:`Confirmer le retrait pour ${em}`;return}
  armed=false;b.disabled=true;
  const {data,error}=await sb.rpc("admin_set_premium",{p_email:em,p_days:d});b.disabled=false;b.textContent="Appliquer";
  if(error||!data?.ok){$("#gpm").className="err";$("#gpm").textContent=data?.error||"Opération refusée.";return}
  $("#gpm").className="okm";$("#gpm").textContent=d?`Premium actif jusqu’au ${dateFr(data.until)} pour ${em}.`:`Accès Premium retiré pour ${em}.`;loadLearners();
 };
 $("#gpe").oninput=$("#gpd").onchange=()=>{armed=false;$("#gpb").textContent="Appliquer"};
}

boot();
