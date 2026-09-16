// STUN pour le direct WebRTC (même WiFi). Hors LAN, le relais socket.io prend le relais.
var ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
