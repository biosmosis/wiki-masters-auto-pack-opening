#!/usr/bin/env node
/**
 * Ouvre tous les packs disponibles sur wiki-masters.com pour chaque compte,
 * attend 10 min quand il n'y en a plus, et renouvelle automatiquement les tokens Supabase.
 * Node 18+, aucune dépendance.
 *
 * Cookies : fichier texte "cookies.txt" à côté du script.
 * Pour chaque compte :
 *   Ligne 1 : premier cookie (.0)
 *   Ligne 2 : deuxième cookie (.1)
 *   Ligne 3 : nom d'utilisateur (username)
 * Séparés par trois tirets (---) :
 *
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
 *   MonPseudo1
 *   ---
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
 *   sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
 *   MonPseudo2
 *
 * ou simplement les valeurs brutes de cookies :
 *
 *   base64-eyJ...
 *   To1NTo...
 *   MonPseudo1
 *   ---
 *   base64-eyJ...
 *   To1NTo...
 *   MonPseudo2
 *
 * À chaque renouvellement de token, le script réécrit ce fichier avec les
 * nouveaux cookies (droits 600). Ne jamais partager ce fichier.
 *
 * Lancement :
 *   node script.mjs                      # cooldown 10 min, ./cookies.txt
 *   node script.mjs -c 11 -f mes_cookies.txt
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
const BETWEEN_ACCOUNTS_MS = 1000;

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
  try {
    return JSON.parse(b64urlDecode(token.split(".")[1]));
  } catch {
    return {};
  }
}

function extractCookieValue(line) {
  if (line.startsWith("sb-") && line.includes("=")) {
    return line.slice(line.indexOf("=") + 1).trim();
  }
  return line.trim();
}

function loadAccounts() {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`Fichier ${COOKIE_FILE} introuvable : crée-le avec les cookies et les noms d'utilisateurs.`);
    process.exit(1);
  }

  const content = readFileSync(COOKIE_FILE, "utf8");
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let currentLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (/^---+$/.test(line)) {
      if (currentLines.length > 0) {
        blocks.push(currentLines);
        currentLines = [];
      }
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    blocks.push(currentLines);
  }

  if (blocks.length === 0) {
    console.error(`${COOKIE_FILE} est vide.`);
    process.exit(1);
  }

  const accounts = [];
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    if (block.length < 2) {
      console.error(`Compte #${idx + 1} dans ${COOKIE_FILE} incomplet : au moins 2 lignes de cookies attendues.`);
      process.exit(1);
    }

    let cookieLines;
    let username;

    if (block.length === 2) {
      cookieLines = [block[0], block[1]];
      username = `Compte ${idx + 1}`;
    } else {
      const lastLine = block[block.length - 1];
      if (!lastLine.startsWith("sb-") && !lastLine.startsWith("base64-") && lastLine.length < 200) {
        username = lastLine;
        cookieLines = block.slice(0, -1);
      } else {
        cookieLines = block.slice(0, 2);
        username = block[2] || `Compte ${idx + 1}`;
      }
    }

    if (username.toLowerCase().startsWith("username=")) {
      username = username.slice(9).trim();
    }

    let session;
    try {
      const raw = cookieLines.map(extractCookieValue).join("").replace(/^base64-/, "");
      session = JSON.parse(b64urlDecode(raw));
    } catch {
      console.error(`Impossible de lire les cookies du compte #${idx + 1} (${username}) dans ${COOKIE_FILE} : vérifie que les valeurs .0 et .1 sont complètes et dans l'ordre.`);
      process.exit(1);
    }

    accounts.push({
      id: idx + 1,
      username,
      session,
      opened: 0,
      totalCards: 0,
      rarity_count: {},
      disabled: false,
    });
  }

  return accounts;
}

function cookieChunks(session) {
  const encoded = "base64-" + b64urlEncode(JSON.stringify(session));
  const chunks = [];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    chunks.push(encoded.slice(i, i + CHUNK_SIZE));
  }
  if (chunks.length === 1) {
    return [[`${COOKIE_NAME}.0`, chunks[0]], [`${COOKIE_NAME}.1`, ""]];
  }
  return chunks.map((c, i) => [`${COOKIE_NAME}.${i}`, c]);
}

function cookieHeader(session) {
  return cookieChunks(session)
    .filter(([_, v]) => v && v.length > 0)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

function saveAccounts(accounts) {
  const parts = accounts.map((acc) => {
    const chunks = cookieChunks(acc.session);
    const cookieLines = chunks.map(([n, v]) => `${n}=${v}`).join("\n");
    return `${cookieLines}\n${acc.username}`;
  });
  const text = parts.join("\n---\n") + "\n";
  writeFileSync(COOKIE_FILE, text, { mode: 0o600 });
  try { chmodSync(COOKIE_FILE, 0o600); } catch {}
}

const accounts = loadAccounts();
log(`${accounts.length} compte(s) chargé(s) : ${accounts.map((a) => a.username).join(", ")}`);

async function refreshSession(account, reason) {
  const iss = jwtPayload(account.session.access_token).iss;
  log(`[${account.username}] Renouvellement du token (${reason})…`);

  try {
    const res = await fetch(`${iss}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ refresh_token: account.session.refresh_token }),
    });
    if (!res.ok) {
      console.error(`[${account.username}] Échec du renouvellement (HTTP ${res.status}) : ${(await res.text()).slice(0, 300)}`);
      console.error(`[${account.username}] Le refresh_token est peut-être invalide (session révoquée ou utilisée ailleurs). Reconnecte-toi et mets de nouveaux cookies dans ${COOKIE_FILE}.`);
      return false;
    }
    account.session = await res.json();
    saveAccounts(accounts);
    log(`[${account.username}] Token renouvelé, ${COOKIE_FILE} mis à jour.`);
    return true;
  } catch (err) {
    console.error(`[${account.username}] Erreur lors du renouvellement : ${err.message}`);
    return false;
  }
}

async function ensureFresh(account) {
  const exp = account.session.expires_at ?? jwtPayload(account.session.access_token).exp;
  if (exp && exp - Date.now() / 1000 < REFRESH_MARGIN_S) {
    return await refreshSession(account, "expiration proche");
  }
  return true;
}

async function openPack(account) {
  return fetch(API_URL, {
    method: "POST",
    headers: {
      Cookie: cookieHeader(account.session),
      Referer: "https://www.wiki-masters.com/pulls",
      Origin: "https://www.wiki-masters.com",
      "User-Agent": "Mozilla/5.0",
    },
  });
}

async function countdown(ms) {
  const end = Date.now() + ms;
  log(`Plus de pack disponible sur l'ensemble des comptes. Pause de ${Math.round(ms / 60000)} min…`);
  while (Date.now() < end) {
    await sleep(Math.min(60_000, end - Date.now()));
    const left = Math.max(0, end - Date.now());
    if (left > 0) log(`  … encore ${Math.ceil(left / 60000)} min`);
  }
}

process.on("SIGINT", () => {
  log("Arrêt demandé.");
  process.exit(0);
});

while (true) {
  for (const account of accounts) {
    if (account.disabled) continue;

    while (true) {
      const freshOk = await ensureFresh(account);
      if (!freshOk) {
        account.disabled = true;
        break;
      }

      let res = await openPack(account);
      if (res.status === 401) {
        const refreshed = await refreshSession(account, "réponse 401");
        if (!refreshed) {
          account.disabled = true;
          break;
        }
        res = await openPack(account);
        if (res.status === 401) {
          console.error(`[${account.username}] Toujours 401 après renouvellement : ce compte est désactivé.`);
          account.disabled = true;
          break;
        }
      }

      const text = await res.text();

      if (res.ok) {
        account.opened++;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
        appendFileSync(RESULTS_FILE, JSON.stringify({ account: account.username, ...data }) + "\n");
        const cardsList = Array.isArray(data.cards)
          ? data.cards.map((c) => `${c.wikipedia_title} (${c.rarity})`).join(", ")
          : "aucune carte";
        log(`[${account.username}] Pack #${account.opened} ouvert : ${cardsList}`);

        if (Array.isArray(data.cards)) {
          account.totalCards += data.cards.length;
          for (const c of data.cards) {
            account.rarity_count[c.rarity] = (account.rarity_count[c.rarity] || 0) + 1;
          }
        }
        const formattedCount = Object.entries(account.rarity_count)
          .map(([rarity, count]) => `${rarity} : ${count}`)
          .join(", ");
        log(`[${account.username}] Total cartes : ${account.totalCards} (${formattedCount})`);

        await sleep(BETWEEN_PACKS_MS);
        continue;
      } else {
        let errorData;
        try {
          errorData = JSON.parse(text);
        } catch {
          errorData = { message: text };
        }
        log(`[${account.username}] HTTP ${res.status} : ${errorData.error || errorData.message}`);
        break;
      }
    }

    await sleep(BETWEEN_ACCOUNTS_MS);
  }

  const activeAccounts = accounts.filter((a) => !a.disabled);
  if (activeAccounts.length === 0) {
    console.error("Tous les comptes sont désactivés ou invalides : arrêt du script.");
    process.exit(1);
  }

  await countdown(COOLDOWN_MS);
}