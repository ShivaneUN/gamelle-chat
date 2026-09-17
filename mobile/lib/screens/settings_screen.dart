import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

import '../services/node_bridge_service.dart';

const _bg = Color(0xFF0B0D12);
const _card = Color(0xFF151821);
const _tile = Color(0xFF1C2030);
const _accent = Color(0xFFFF7A45);
const _muted = Color(0xFF8B93A7);

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _bridge = NodeBridgeService.instance;
  StreamSubscription<NodeBridgeMessage>? _sub;
  bool _busy = false;
  bool _tunnelBusy = false;
  PermissionStatus _notifStatus = PermissionStatus.denied;

  @override
  void initState() {
    super.initState();
    _sub = _bridge.messages.listen((_) {
      if (mounted) setState(() {});
    });
    _refreshNotif();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refreshNotif() async {
    final status = await Permission.notification.status;
    if (!mounted) return;
    setState(() => _notifStatus = status);
  }

  Future<void> _copy(String value, {String done = 'Lien copié'}) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
  }

  Future<void> _toggleServer(bool on) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (on) {
        if (!await Permission.notification.isGranted) {
          await Permission.notification.request();
          await _refreshNotif();
        }
        final ok = await _bridge.start();
        if (!mounted) return;
        if (!ok) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(_bridge.lastError ?? 'Impossible de démarrer le serveur.'),
            ),
          );
        }
      } else {
        await _bridge.stop();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _toggleTunnel(bool on) async {
    if (_tunnelBusy) return;
    setState(() => _tunnelBusy = true);
    try {
      await _bridge.setTunnelEnabled(on);
    } finally {
      if (mounted) setState(() => _tunnelBusy = false);
    }
  }

  Future<void> _openNotifSettings() async {
    await openAppSettings();
    await _refreshNotif();
  }

  String get _notifLabel {
    if (_notifStatus.isGranted) return 'Autorisées';
    if (_notifStatus.isPermanentlyDenied) return 'Refusées — ouvrir les réglages';
    if (_notifStatus.isDenied) return 'Non accordées';
    return _notifStatus.toString().split('.').last;
  }

  @override
  Widget build(BuildContext context) {
    final running = _bridge.status == NodeStatus.running;
    final tunnelOn = _bridge.tunnelEnabled;

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _bg,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text('Réglages'),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          _SettingsCard(
            child: Column(
              children: [
                _SettingsTile(
                  icon: Icons.wifi_rounded,
                  title: 'Wi-Fi local',
                  subtitle: _bridge.localUrl.replaceFirst(RegExp(r'^https?://'), ''),
                  onTap: () => _copy(_bridge.localUrl, done: 'Lien local copié'),
                  trailing: IconButton(
                    tooltip: 'Copier',
                    onPressed: () => _copy(_bridge.localUrl, done: 'Lien local copié'),
                    icon: const Icon(Icons.copy_rounded, color: _accent),
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF2A3142)),
                _SettingsTile(
                  icon: Icons.power_settings_new_rounded,
                  title: 'Serveur',
                  subtitle: running
                      ? 'En cours'
                      : (_busy ? 'Changement…' : (_bridge.lastError ?? 'Arrêté')),
                  trailing: Switch(
                    value: running,
                    activeThumbColor: _accent,
                    onChanged: _busy ? null : _toggleServer,
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF2A3142)),
                _SettingsTile(
                  icon: Icons.cloud_outlined,
                  title: 'Cloudflare',
                  subtitle: !tunnelOn
                      ? 'Désactivé — accès local uniquement'
                      : (_bridge.publicUrl != null
                          ? 'Tunnel actif'
                          : (_bridge.tunnelError ?? 'Connexion…')),
                  trailing: Switch(
                    value: tunnelOn,
                    activeThumbColor: _accent,
                    onChanged: _tunnelBusy ? null : _toggleTunnel,
                  ),
                ),
                const Divider(height: 1, color: Color(0xFF2A3142)),
                _SettingsTile(
                  icon: Icons.notifications_outlined,
                  title: 'Notifications',
                  subtitle: _notifLabel,
                  onTap: _openNotifSettings,
                  trailing: IconButton(
                    tooltip: 'Ouvrir les réglages',
                    onPressed: _openNotifSettings,
                    icon: const Icon(Icons.open_in_new_rounded, color: _accent),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 12, left: 4, right: 4),
            child: Text(
              running
                  ? 'Le Wi-Fi local reste disponible même si Cloudflare est coupé.'
                  : 'Démarre le serveur pour exposer le Wi-Fi local et le tunnel.',
              style: const TextStyle(color: _muted, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsCard extends StatelessWidget {
  const _SettingsCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(22),
      ),
      clipBehavior: Clip.antiAlias,
      child: child,
    );
  }
}

class _SettingsTile extends StatelessWidget {
  const _SettingsTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.onTap,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: _tile,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              Icon(icon, color: Colors.white, size: 26),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: _muted, fontSize: 13),
                    ),
                  ],
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
        ),
      ),
    );
  }
}
