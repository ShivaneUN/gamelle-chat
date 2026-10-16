# Gamelle Chat

Prototype à lancer sur la tablette (Termux / APK) ou un PC. Le Récepteur reste près de la gamelle ; le Contrôleur peut être **sur le même WiFi ou en 4G / autre réseau**.

## Ce qui est inclus
- Jumelage par code : **plusieurs Contrôleurs** + 1 Récepteur avec le même code
- **HTTPS local automatique** (certificat auto-signé généré au 1er démarrage)
- **Accès distant** : tunnel Cloudflare (à configurer toi-même), pour ouvrir le Contrôleur depuis n’importe quel réseau
- **Bibliothèque de messages personnalisés** (texte et/ou audio enregistré)
- Horaires visibles et modifiables depuis le Contrôleur ET le Récepteur, toujours synchronisés
- Vue caméra en direct (JPEG + WebRTC selon le réseau)
- Choix de la caméra, photo / vidéo à distance, galerie, parler à distance
- Sauvegarde persistante : horaires, messages et audios survivent à un redémarrage

## Installation

```bash
cd gamelle-chat
npm install
npm start
```

Sans tunnel configuré, tu as au minimum le HTTPS local (`https://localhost:3000` / IP LAN).

## Accès 4G : chaque install a SES propres liens

- **Local** : HTTPS auto (`localhost` / IP LAN) — toujours créé au démarrage.
- **Online** : sans config, un **tunnel Cloudflare rapide** (`*.trycloudflare.com`) est créé — **URL différente à chaque machine / démarrage**.
- **URL fixe** (optionnel) : crée **ton** compte Cloudflare + Named Tunnel, puis place `tunnel.token` et `tunnel.config.json` dans le stockage persistant de l’app (ou en local pour un build privé). **Ne partage jamais** le token/URL d’un autre.

Les releases publiques GitHub **n’embarquent aucun** lien ni token Cloudflare perso.

1. Compte [Cloudflare](https://dash.cloudflare.com) (gratuit OK)
2. **Zero Trust → Networks → Tunnels → Create**
3. Voir `tunnel.token.example` et `tunnel.config.json.example`
4. Sur Android, les secrets vont dans `gamelle-persist/` (survivent aux OTA)

Pour désactiver le tunnel : `TUNNEL=0 npm start`.

## Utilisation hors WiFi

1. Lance le serveur **sur la tablette** (avec internet)
2. Tablette : rôle **Récepteur**, active le son + la caméra
3. Téléphone (4G) : **scanne le QR** sur la tablette (lien de jumelage chiffré), connecte-toi avec un compte créé sur la tablette
4. Pas d’avertissement de certificat sur l’URL Cloudflare (vrai HTTPS)

## Sécurité (Access + routes)

### Cloudflare Access (Zero Trust) — config dashboard, pas dans le repo
Optionnel mais recommandé : devant ton Named Tunnel, active **Zero Trust → Access → Applications** et exige un login Cloudflare (email / PIN) **avant** d’atteindre Gamelle. Ça bloque les inconnus même s’ils trouvent ton domaine.

### Protection dans le repo (déjà en place)
- QR = `/j/<token AES-GCM>` : le code de jumelage n’est plus en clair dans le lien
- Plus d’URL affichée sous les QR
- `/api/active-code`, mises à jour, création de comptes : **tablette seule** (local)
- Caméra JPEG (`/api/live`), médias, alarmes : **session + jumelage** requis
- Anciens liens `/c/CODE` en clair refusés

Le secret de chiffrement est local (`data/pair-secret.key`), jamais commit.

## ⚠️ Avertissement de sécurité au premier accès local (normal)

Le certificat local est auto-signé :
- Chrome : "Paramètres avancés" puis "Continuer vers… (dangereux)"
- Normal : la connexion reste chiffrée

## Limites connues
- L’écran du récepteur doit rester allumé (limite du navigateur)
- La tablette doit rester allumée et connectée à internet pour l’accès 4G
- Sans Named Tunnel + token, l’URL Cloudflare rapide change à chaque démarrage
