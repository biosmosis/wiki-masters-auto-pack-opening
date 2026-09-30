#!/usr/bin/env node
/**
 * Ouvre tous les packs disponibles sur wiki-masters.com, attend 10 min
 * quand il n'y en a plus, et renouvelle automatiquement les tokens Supabase.
 * Node 18+, aucune dépendance.
 *
 * Cookies : fichier texte "cookies.txt" à côté du script, une ligne par cookie,
 * dans l'ordre (.0 puis .1). Les deux formats suivants sont acceptés :
 *
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
 *
 * ou simplement les valeurs brutes, une par ligne :
 *
 *   base64-eyJ...
 *   To1NTo...
 *
 * À chaque renouvellement de token, le script réécrit ce fichier avec les
 * nouveaux cookies (droits 600). Ne jamais partager ce fichier.
 *
 * Lancement :
 *   node wm_auto.mjs                      # cooldown 10 min, ./cookies.txt
 *   node wm_auto.mjs -c 11 -f mes_cookies.txt
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = "https://www.wiki-masters.com/api/packs/open";
const COOKIE_NAME = "sb-cyrxjeppjqsxxjayfrur-auth-token";
const ANON_KEY =
  process.env.WM_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg";
const RESULTS_FILE = "packs.jsonl";
const CHUNK_SIZE = 3180;
const REFRESH_MARGIN_S = 120;
const BETWEEN_PACKS_MS = 7000;

const { values } = parseArgs({
  options: {
    cooldown: { type: "string", short: "c", default: "10" },
    file: { type: "string", short: "f", default: "cookies.txt" },
  },
});
const COOLDOWN_MS = parseFloat(values.cooldown) * 60_000;
const COOKIE_FILE = values.file;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString("fr-FR")}]`, ...a);

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64urlEncode = (s) => Buffer.from(s, "utf8").toString("base64url");

function jwtPayload(token) {
  return JSON.parse(b64urlDecode(token.split(".")[1]));
}

function loadSession() {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`Fichier ${COOKIE_FILE} introuvable : crée-le avec les valeurs des cookies ${COOKIE_NAME}.0 et .1 (une par ligne).`);
    process.exit(1);
  }
  const values_ = readFileSync(COOKIE_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("sb-") && l.includes("=") ? l.slice(l.indexOf("=") + 1) : l));

  if (values_.length === 0) {
    console.error(`${COOKIE_FILE} est vide.`);
    process.exit(1);
  }
  try {
    const raw = values_.join("").replace(/^base64-/, "");
    return JSON.parse(b64urlDecode(raw));
  } catch {
    console.error(`Impossible de lire les cookies de ${COOKIE_FILE} : vérifie que les valeurs .0 et .1 sont complètes et dans l'ordre.`);
    process.exit(1);
  }
}

function cookieChunks() {
  const encoded = "base64-" + b64urlEncode(JSON.stringify(session));
  const chunks = [];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) chunks.push(encoded.slice(i, i + CHUNK_SIZE));
  return chunks.length === 1
    ? [[COOKIE_NAME, chunks[0]]]
    : chunks.map((c, i) => [`${COOKIE_NAME}.${i}`, c]);
}

const cookieHeader = () => cookieChunks().map(([n, v]) => `${n}=${v}`).join("; ");

function saveSession() {
  const text = cookieChunks().map(([n, v]) => `${n}=${v}`).join("\n") + "\n";
  writeFileSync(COOKIE_FILE, text, { mode: 0o600 });
  try { chmodSync(COOKIE_FILE, 0o600); } catch {}
}

let session = loadSession();

async function refreshSession(reason) {
  const iss = jwtPayload(session.access_token).iss;
  log(`Renouvellement du token (${reason})…`);

  const res = await fetch(`${iss}/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) {
    console.error(`Échec du renouvellement (HTTP ${res.status}) : ${(await res.text()).slice(0, 300)}`);
    console.error(`Le refresh_token est peut-être invalide (session révoquée ou utilisée ailleurs). Reconnecte-toi et mets de nouveaux cookies dans ${COOKIE_FILE}.`);
    process.exit(1);
  }
  session = await res.json();
  saveSession();
  log(`Token renouvelé, ${COOKIE_FILE} mis à jour.`);
}

async function ensureFresh() {
  const exp = session.expires_at ?? jwtPayload(session.access_token).exp;
  if (exp - Date.now() / 1000 < REFRESH_MARGIN_S) await refreshSession("expiration proche");
}

async function openPack() {
  return fetch(API_URL, {
    method: "POST",
    headers: {
      Cookie: cookieHeader(),
      Referer: "https://www.wiki-masters.com/pulls",
      Origin: "https://www.wiki-masters.com",
      "User-Agent": "Mozilla/5.0",
    },
  });
}

async function countdown(ms) {
  const end = Date.now() + ms;
  log(`Plus de pack disponible. Pause de ${Math.round(ms / 60000)} min…`);
  while (Date.now() < end) {
    await sleep(Math.min(60_000, end - Date.now()));
    const left = Math.max(0, end - Date.now());
    if (left > 0) log(`  … encore ${Math.ceil(left / 60000)} min`);
  }
}

process.on("SIGINT", () => { log("Arrêt demandé."); process.exit(0); });

let opened = 0;
while (true) {
  let rarity_count = {};

  await ensureFresh();

  let res = await openPack();
  if (res.status === 401) {
    await refreshSession("réponse 401");
    res = await openPack();
    if (res.status === 401) {
      console.error("Toujours 401 après renouvellement : arrêt.");
      process.exit(1);
    }
  }

  const text = await res.text();

  if (res.ok) {
    opened++;
    let data;
    try { 
        data = JSON.parse(text); 
    } catch { 
        data = { raw: text };
    }
    appendFileSync(RESULTS_FILE, JSON.stringify(data) + "\n");
    log(`Pack #${opened} ouvert : ${data.cards.map(c => `${c.wikipedia_title} (${c.rarity})`).join(', ')}`);
    for (const c of data.cards) {
        rarity_count[c.rarity] += (rarity_count[c.rarity] || 0) + 1;
    }
    let formattedCount = Object.entries(rarity_count)
        .map(([rarity, count]) => `${rarity} : ${count}`)
        .join(', '); 
    log(`Compte cartes : ${formattedCount}`);
    
    await sleep(BETWEEN_PACKS_MS);
    continue;
  } else {
    let errorData;

    try {
        errorData = JSON.parse(text);
    } catch {
        errorData = { message: text };
    }
  }

  log(`HTTP ${res.status} : ${errorData.error || errorData.message}`); 

  await countdown(COOLDOWN_MS);
}