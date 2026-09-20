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

## Accès 4G : crée TON propre tunnel Cloudflare

Ce dépôt **ne fournit pas** d’URL publique prête à l’emploi. Chaque personne doit créer **son** compte Cloudflare et **son** tunnel.

1. Crée un compte sur [Cloudflare](https://dash.cloudflare.com) (offre gratuite OK)
2. **Zero Trust → Networks → Tunnels → Create a tunnel** (ex. nom `gamelle`)
3. Copie le **token** du tunnel :
   - copie `tunnel.token.example` → `tunnel.token`
   - colle **uniquement** le token (une ligne)
4. Configure l’hostname public du tunnel (sous-domaine + ton domaine Cloudflare) vers `http://127.0.0.1:3001`
5. Copie `tunnel.config.json.example` → `tunnel.config.json` et mets **ton** `publicUrl` + `allowedSuffixes`
6. Pour l’APK Android, copie aussi ces deux fichiers dans :
   - `mobile/android/app/src/main/assets/`
   - `mobile/android/app/src/main/assets/nodejs-project/`

**Ne commit jamais** `tunnel.token` ni ton vrai `tunnel.config.json` (déjà dans `.gitignore`).

Sans `tunnel.token`, l’app peut utiliser un tunnel rapide `trycloudflare.com` (URL qui change).

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
