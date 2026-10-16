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

**Chaque nouvelle maj doit rester clean** — avant de publier une release :

```bash
bash tools/ensure-public-tunnel-assets.sh
bash tools/check-no-private-secrets.sh path/to/app-release.apk
```

(CI GitHub Actions `No private secrets` bloque aussi les PR si un lien/token perso réapparaît.)

1. Compte [Cloudflare](https://dash.cloudflare.com) (gratuit OK)
2. **Zero Trust → Networks → Tunnels → Create**
3. Voir `tunnel.token.example` et `tunnel.config.json.example`
4. Sur Android, les secrets vont dans `gamelle-persist/` (survivent aux OTA)

Pour désactiver le tunnel : `TUNNEL=0 npm start`.

## Utilisation hors WiFi

1. Lance le serveur **sur la tablette** (avec internet)
2. Tablette : rôle **Récepteur**, active le son + la caméra
3. Téléphone (4G) : ouvre **ton** URL Cloudflare (celle de *ton* `tunnel.config.json`), connecte-toi avec un compte créé sur la tablette, même code de jumelage
4. Pas d’avertissement de certificat sur l’URL Cloudflare (vrai HTTPS)

## ⚠️ Avertissement de sécurité au premier accès local (normal)

Le certificat local est auto-signé :
- Chrome : "Paramètres avancés" puis "Continuer vers… (dangereux)"
- Normal : la connexion reste chiffrée

## Limites connues
- L’écran du récepteur doit rester allumé (limite du navigateur)
- La tablette doit rester allumée et connectée à internet pour l’accès 4G
- Sans Named Tunnel + token, l’URL Cloudflare rapide change à chaque démarrage
