# Gamelle Chat

Prototype à lancer sur la tablette (Termux) ou un PC. Le Récepteur reste près de la gamelle ; le Contrôleur peut être **sur le même WiFi ou en 4G / autre réseau**.

## Ce qui est inclus
- Jumelage par code : **plusieurs Contrôleurs** + 1 Récepteur avec le même code
- **HTTPS local automatique** (certificat auto-signé généré au 1er démarrage)
- **Accès distant** : tunnel Cloudflare au démarrage, pour ouvrir le Contrôleur depuis n’importe quel réseau
- **Bibliothèque de messages personnalisés** (texte et/ou audio enregistré)
- Horaires visibles et modifiables depuis le Contrôleur ET le Récepteur, toujours synchronisés
- Bouton "Activer le son" obligatoire une fois sur le récepteur
- Arrêt automatique de l'alarme après la durée programmée, ou **déclenchement / arrêt manuel depuis les 2 appareils**
- Vue caméra en direct : WebRTC sur le même WiFi, **relais via le serveur hors WiFi**
- **Choix de la caméra** (avant/arrière/externe) depuis le Contrôleur
- Prise de photo et vidéo (5s) à distance
- Galerie : suppression manuelle + purge automatique après 24h **côté Contrôleur uniquement** (copie récepteur gardée sur la tablette)
- Parler à distance (push-to-talk), y compris hors WiFi
- Sauvegarde persistante : horaires, messages et audios survivent à un redémarrage du serveur

## Installation

```bash
cd gamelle-chat
npm install
npm start
```

Le terminal affiche :
```
Sur la tablette (récepteur) : https://localhost:3000
Même WiFi                   : https://192.168.X.X:3000
Depuis n'importe où (4G / autre WiFi) : https://xxxx.trycloudflare.com
```

## Utilisation hors WiFi

1. Lance `npm start` **sur la tablette** (elle doit avoir internet)
2. Sur la tablette : ouvre l’adresse locale, accepte l’avertissement, rôle **Récepteur**, active le son + la caméra
3. Sur le téléphone (4G ou autre WiFi) : ouvre l’URL `https://xxxx.trycloudflare.com` affichée dans le terminal (aussi copiable sur la page d’accueil), **même code**, rôle **Contrôleur**
4. Pas d’avertissement de certificat sur l’URL Cloudflare (vrai HTTPS)

L’URL distante **change à chaque redémarrage** (tunnel rapide). Pour désactiver le tunnel : `TUNNEL=0 npm start`.

## ⚠️ Avertissement de sécurité au premier accès local (normal)

Le certificat local est auto-signé, donc le navigateur affiche un avertissement la première fois :
- Chrome : "Paramètres avancés" puis "Continuer vers... (dangereux)"
- C’est normal : la connexion reste chiffrée

## Limites connues
- L’écran du récepteur doit rester allumé (limite du navigateur)
- La tablette doit rester allumée et connectée à internet pour l’accès 4G
- Le tunnel rapide Cloudflare n’a pas d’URL fixe
