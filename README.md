# wiki-masters auto pack opener

<br />

Script Node.js qui ouvre automatiquement les packs [wiki-masters](https://www.wiki-masters.com) sur un ou plusieurs comptes. Quand il n'y a plus de pack disponible, il attend 10 minutes (le temps de régénération) puis reprend. Il renouvelle aussi tout seul les tokens de session Supabase, pour pouvoir tourner en continu.  

> **Avertissement** : utilise ce script uniquement sur ton propre compte et vérifie que l'automatisation est autorisée par les conditions d'utilisation du site. Le compte peut être sanctionné en cas d'abus. Tu es responsable de l'usage que tu en fais.

## Fonctionnalités

- Support multi-comptes : ouvre les packs pour chaque compte configuré.
- Ouvre tous les packs disponibles à la suite pour chaque compte.
- Suivi détaillé par compte : nom du compte, cartes tirées, total des cartes et répartition des raretés.
- Pause automatique (10 min par défaut, configurable) quand il n'y a plus de pack, avec un compte à rebours dans la console.
- Renouvellement automatique des tokens avant leur expiration (et en cas de réponse 401).
- Cookies stockés dans un simple fichier texte, mis à jour à chaque renouvellement.
- Résultats de chaque ouverture sauvegardés dans `packs.jsonl`.
- Aucune dépendance à installer.

## Prérequis

- [Node.js](https://nodejs.org) **18 ou plus récent** (le script utilise `fetch` natif). Vérifie avec :

  ```bash
  node --version
  ```

- Un compte sur wiki-masters.com.

## Installation

```bash
git clone https://github.com/biosmosis/wiki-masters-auto-pack-opening.git
cd wiki-masters-auto-pack-opening
```

## Configuration

### 1. Récupérer tes cookies de session

1. Ouvre une **fenêtre privée** et connecte-toi sur <https://www.wiki-masters.com>.
2. Ouvre les outils de développement (`F12`).
3. Va dans l'onglet **Application** (Chrome / Edge) ou **Stockage** (Firefox), puis **Cookies** → `https://www.wiki-masters.com`.
4. Repère les deux cookies dont le nom commence par `sb-` et finit par `-auth-token.0` et `-auth-token.1`.
5. Copie la **valeur** de chacun.
6. **Ferme la fenêtre privée sans te déconnecter.** Un clic sur « Se déconnecter » révoquerait la session que le script doit utiliser.

L'usage d'une fenêtre privée est recommandé : à chaque renouvellement, Supabase invalide l'ancien `refresh_token`. Si le même compte restait connecté dans ton navigateur habituel avec la même session, il risquerait d'être déconnecté.

### 2. Créer `cookies.txt`

Crée un fichier `cookies.txt` à la racine du projet. Chaque compte est composé de 3 lignes :
1. Le premier cookie (`.0`)
2. Le deuxième cookie (`.1`)
3. Le nom d'utilisateur (pseudo)

Pour ajouter d'autres comptes, sépare-les par trois tirets (`---`).

Format standard avec les préfixes :

```
sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
Compte1
---
sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
Compte2
---
sb-cyrxjeppjqsxxjayfrur-auth-token.0=base64-eyJ...
sb-cyrxjeppjqsxxjayfrur-auth-token.1=To1NTo...
Compte3
```

Ou simplement avec les valeurs brutes :

```
base64-eyJ...
To1NTo...
Compte1
---
base64-eyJ...
To1NTo...
Compte2
```

Les lignes vides et celles qui commencent par `#` sont ignorées.

### 3. Clé Supabase (optionnel)

Le script contient déjà la clé publique `anon` du projet Supabase du site (la même pour tous les visiteurs, elle n'ouvre aucun accès à ton compte). Si le site la change un jour, le renouvellement des tokens échouera avec une erreur de clé invalide. Dans ce cas, récupère la nouvelle valeur de l'en-tête `apikey` dans l'onglet **Réseau** des outils de développement (filtre `supabase.co`), puis passe-la au script :

```bash
export WM_SUPABASE_ANON_KEY='nouvelle_cle'
```

## Lancement

```bash
node script.mjs
```

Exemple de sortie :

```
[14:02:11] 2 compte(s) chargé(s) : Compte1, Compte2
[14:02:11] [Compte1] Pack #1 ouvert : Albert Einstein (common), Marie Curie (rare), Isaac Newton (epic)
[14:02:11] [Compte1] Total cartes : 3 (common : 1, rare : 1, epic : 1)
[14:02:18] [Compte1] HTTP 400 : Plus de pack disponible
[14:02:19] [Compte2] Pack #1 ouvert : Alan Turing (common), Ada Lovelace (legendary)
[14:02:19] [Compte2] Total cartes : 2 (common : 1, legendary : 1)
[14:02:26] [Compte2] HTTP 400 : Plus de pack disponible
[14:02:26] Plus de pack disponible sur l'ensemble des comptes. Pause de 10 min…
[14:03:26]   … encore 9 min
```

Arrête le programme à tout moment avec `Ctrl+C`.

### Options

| Option | Alias | Défaut | Description |
| --- | --- | --- | --- |
| `--cooldown` | `-c` | `10` | Durée de la pause, en minutes, quand il n'y a plus de pack |
| `--file` | `-f` | `cookies.txt` | Chemin du fichier de cookies |

Exemples :

```bash
node wm_auto.mjs -c 11
node wm_auto.mjs -f ~/secrets/wm-cookies.txt
```

### Lancer en arrière-plan

Avec `tmux` ou `screen` :

```bash
tmux new -s packs
node wm_auto.mjs
# Ctrl+B puis D pour détacher, tmux attach -t packs pour revenir
```

Ou avec `pm2` :

```bash
npm install -g pm2
pm2 start wm_auto.mjs --name wm-packs
pm2 logs wm-packs
```

## Fichiers générés

| Fichier | Contenu |
| --- | --- |
| `cookies.txt` | Ta session. Réécrit automatiquement à chaque renouvellement de token. |
| `packs.jsonl` | Une ligne JSON par pack ouvert (réponse brute de l'API). |

## Fonctionnement

1. Le script lit `cookies.txt` et reconstitue la session Supabase de chaque compte configuré (`access_token`, `refresh_token`, expiration, pseudo).
2. Pour chaque compte, il ouvre tous les packs disponibles un par un :
   - Avant chaque requête, il vérifie l'expiration du token et le renouvelle automatiquement si nécessaire (en réécrivant `cookies.txt` pour préserver les sessions).
   - En cas de succès : les cartes obtenues sont enregistrées dans `packs.jsonl`, les statistiques (packs ouverts, total des cartes et raretés) sont mises à jour et affichées en console.
   - En cas d'erreur `401` : il tente un renouvellement de token et réessaie une fois.
   - En cas d'erreur de fin de packs (HTTP 4xx) : il passe au compte suivant.
3. Une fois tous les comptes traités, il attend la durée du cooldown (10 min par défaut) avec un compte à rebours, puis recommence un nouveau cycle.

## Dépannage

| Symptôme | Cause probable et solution |
| --- | --- |
| `Fichier cookies.txt introuvable` | Crée le fichier à la racine du projet ou indique son chemin avec `-f`. |
| `Impossible de lire les cookies` | Les valeurs `.0` et `.1` sont incomplètes, dans le mauvais ordre, ou coupées à la copie. Recopie-les en entier. |
| `Échec du renouvellement` | Le `refresh_token` n'est plus valide (déconnexion, session utilisée ailleurs, compte révoqué). Reconnecte-toi, récupère de nouveaux cookies et remplace le contenu de `cookies.txt`. |
| Erreur de clé API au renouvellement | La clé `anon` a changé. Voir la section « Clé Supabase ». |
| Pause de 10 min alors qu'il y a des packs | L'API a renvoyé une erreur (par exemple `500`). Lis le message affiché : le script traite toute erreur non `401` comme une absence de pack. |
| `429` fréquents | Le site limite le débit. Augmente `BETWEEN_PACKS_MS` dans le script. |

## Sécurité

- Ne partage jamais `cookies.txt`, ni en capture d'écran, ni dans une issue, ni dans un message.
- Ne colle jamais tes cookies dans un chat, un forum ou un outil tiers.
- Le fichier est créé avec les droits `600` (lisible uniquement par toi) sur Linux et macOS.
- Si tu penses que tes cookies ont fuité, déconnecte-toi sur le site pour invalider la session.