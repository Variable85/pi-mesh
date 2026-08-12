---
name: mesh-coordination
description: Guide d'utilisation du mesh multi-agents (pi-mesh) — messagerie, réponses, réservations, anti-boucles. À lire quand tu coordonnes avec d'autres agents ou que tu réponds à un message mesh.
---

# Coordination mesh (pi-mesh)

Tu es connecté à un mesh local d'agents pi. Règles et réflexes pour ne pas
créer de doublons, de boucles ou de confusion.

## Se repérer

- `mesh_status` — qui est en ligne, dans quelle room, **statut** (`○idle`,
  `✕stuck` = inactif avec réservations), et les accusés de lecture (`reads:`).
- `mesh_history` — les derniers échanges (mémoire).
- `mesh_ledger` — l'historique DURABLE (hash-only) : filtre par
  `from/to/room/event`. **Utilise-le pour vérifier avant de re-envoyer.**

## Envoyer

- `mesh_send { to: "agent-X", message }` — message direct (room partagée
  requise).
- `mesh_send { broadcast: true, room: "cs-room", message }` — annonce à toute
  la room (le résultat donne `delivered N/M`).
- `awaitReply: true` : attend une réponse (timeout 30 min par défaut).

## Répondre (RÈGLES D'OR)

1. **Toujours `mesh_reply { msgId, message }` avec l'EXACT msgId reçu** — ne
   jamais répondre par un nouveau `mesh_send`.
2. **Une seule réponse par msgId.** Si le résultat te dit `⚠️ déjà répondu à
   ce msgId récemment` — tu as DÉJÀ répondu : n'insiste pas, la réponse est
   partie (`delivered`).
3. **`replyAll: true`** pour répondre à TOUTE la room du message original
   (ex. "mission terminée" visible par tous).
4. **`to: "agent-Y"`** pour faire suivre la réponse à un autre agent que
   l'émetteur.
5. Un **rappel (remind)** dit *"IGNORE ce rappel si tu as DÉJÀ répondu"* :
   si tu as déjà répondu, **ignore-le**.
6. **NE RÉPONDS JAMAIS à une réponse** (reply-à-reply). Les réponses à des
   réponses arrivent avec le label **INFO ONLY** : lis-les (une preuve, une
   correction peuvent être importantes), mais **ne réponds JAMAIS par un
   accusé de réception** — pour réagir (question, correction), envoie un
   **nouveau message** (`mesh_send`), pas un reply.

## Anti-boucles (orchestrateur)

- **`expired` ≠ perdu.** Une réponse tardive est livrée et injectée
  automatiquement. Avant de re-envoyer une mission : `mesh_ledger` ou
  `mesh_history` pour vérifier si la réponse n'est pas déjà arrivée.
- Ne réassigne pas une mission déjà livrée : vérifie d'abord le registre
  (MISSIONS.md / dossier de travail) ET `mesh_ledger`.
- Les agents peuvent être `✕stuck` (inactifs avec réservations) : contacte-les
  via `mesh_send` avant de conclure qu'ils sont perdus.

## Réservations de fichiers

- **`mesh_reserve { paths: [...] }` AVANT d'éditer** un fichier partagé ;
  `mesh_release` dès que terminé.
- Si un `edit`/`write` est **bloqué** : un autre agent a réservé le chemin —
  `mesh_send` au propriétaire pour coordonner, ne force pas.
- Les réservations disparaissent à la déconnexion (et après le TTL configuré).

## Statuts (honnêtes)

`delivered` = écrit sur le socket du destinataire (≠ lu ≠ répondu).
`reads:` dans `mesh_status` montre qui a pris connaissance de tes messages.
