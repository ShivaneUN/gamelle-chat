import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../services/github_update_service.dart';
import '../services/node_bridge_service.dart';
import '../widgets/scan_qr.dart';
import 'receiver_webview.dart';

const _bg = Color(0xFF0B0D12);
const _card = Color(0xFF151821);
const _tile = Color(0xFF1C2030);
const _accent = Color(0xFFFF7A45);
const _muted = Color(0xFF8B93A7);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _bridge = NodeBridgeService.instance;
  bool _busy = false;
  bool _updateBusy = false;
  bool _updateAvailable = false;
  bool _updatesOpen = false;
  String _updateText = 'Vérifie GitHub pour les pages et le serveur.';

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    await WakelockPlus.enable();
    if (!await Permission.notification.isGranted) {
      await Permission.notification.request();
    }
    _bridge.messages.listen((_) {
      if (mounted) setState(() {});
    });
    if (mounted) setState(() {});
    await _startServer();
    await _checkUpdate();
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _updateBusy = true;
      _updateText = 'Vérification GitHub…';
    });
    try {
      final s = await GithubUpdateService.instance.check('');
      if (!mounted) return;
      setState(() {
        _updateAvailable = s.available;
        _updateText = s.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _updateAvailable = false;
        _updateText = 'Impossible de vérifier GitHub.';
      });
    } finally {
      if (mounted) setState(() => _updateBusy = false);
    }
  }

  Future<void> _applyUpdate() async {
    setState(() {
      _updateBusy = true;
      _updateText = 'Téléchargement GitHub…';
    });
    try {
      await GithubUpdateService.instance.saveToken('');
      final s = await GithubUpdateService.instance.apply('');
      if (!mounted) return;
      setState(() {
        _updateAvailable = s.available;
        _updateText = s.message;
      });
      if (s.ok && s.restart) {
        setState(() => _updateText = 'Redémarrage du serveur…');
        final ok = await _bridge.restartAfterUpdate();
        if (!mounted) return;
        setState(() {
          _updateText = ok
              ? 'Mise à jour installée. Serveur relancé.'
              : (_bridge.lastError ?? 'Mise à jour posée, relance le serveur.');
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _updateAvailable = false;
        _updateText = 'Échec de la mise à jour.';
      });
    } finally {
      if (mounted) setState(() => _updateBusy = false);
    }
  }

  bool get _localOk => _bridge.status == NodeStatus.running;

  bool get _cloudflareOk => _bridge.publicUrl != null;

  Future<void> _startServer() async {
    if (!await Permission.notification.isGranted) {
      await Permission.notification.request();
    }
    setState(() => _busy = true);
    final ok = await _bridge.start();
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_bridge.lastError ?? 'Impossible de démarrer le serveur Node.'),
        ),
      );
    }
  }

  Future<void> _goBackground() async {
    try {
      await const MethodChannel('gamelle/lifecycle').invokeMethod<void>('keepAlive', {
        'camera': true,
      });
      await const MethodChannel('gamelle/lifecycle').invokeMethod<void>('background');
    } catch (_) {}
  }

  Future<void> _quit() async {
    try {
      await WakelockPlus.disable();
    } catch (_) {}
    await _bridge.shutdown();
  }

  Future<void> _openReceiver() async {
    await [Permission.camera, Permission.microphone].request();
    try {
      await const MethodChannel('gamelle/lifecycle').invokeMethod<void>('keepAlive', {
        'camera': true,
      });
    } catch (_) {}
    if (!mounted) return;
    final base = Uri.parse(_bridge.localUrl);
    final url = base.replace(path: '/receiver.html').toString();
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReceiverWebView(url: url),
      ),
    );
  }

  Future<void> _copy(String value, {String done = 'Lien copié'}) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(done)),
    );
  }

  String get _localHost {
    return _bridge.localUrl.replaceFirst(RegExp(r'^https?://'), '');
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _goBackground();
      },
      child: Scaffold(
        backgroundColor: _bg,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
            child: Column(
              children: [
                const Text(
                  'Gamelle Chat',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 16),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final wide = constraints.maxWidth >= 720;
                      if (wide) {
                        return Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Expanded(child: _pairingPanel(expand: true)),
                            const SizedBox(width: 16),
                            Expanded(child: _actionsPanel(expand: true)),
                          ],
                        );
                      }
                      return ListView(
                        children: [
                          _pairingPanel(expand: false),
                          const SizedBox(height: 16),
                          _actionsPanel(expand: false),
                        ],
                      );
                    },
                  ),
                ),
                TextButton(
                  onPressed: _quit,
                  child: const Text(
                    'Quitter',
                    style: TextStyle(color: _accent, fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _pairingPanel({required bool expand}) {
    final remote = _bridge.publicUrl;
    final pair = _bridge.pairCode;
    final qr = remote == null
        ? const SizedBox(
            height: 220,
            child: Center(child: CircularProgressIndicator(color: _accent)),
          )
        : GestureDetector(
            onTap: () => _copy(remote),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: ScanQr(data: remote, size: expand ? 260 : 220),
            ),
          );

    final body = Column(
      children: [
        const Text(
          'Scanner pour piloter',
          style: TextStyle(color: _muted, fontWeight: FontWeight.w600, fontSize: 15),
        ),
        const SizedBox(height: 16),
        if (expand) Expanded(child: Center(child: qr)) else Center(child: qr),
        const SizedBox(height: 16),
        _PairDigits(code: pair),
        const SizedBox(height: 14),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 8,
          runSpacing: 8,
          children: [
            _StatusPill(
              label: _localOk ? 'Local OK' : 'Local…',
              ok: _localOk,
            ),
            _StatusPill(
              label: _cloudflareOk
                  ? 'Cloudflare OK'
                  : (_bridge.tunnelError == null ? 'Cloudflare…' : 'Cloudflare'),
              ok: _cloudflareOk,
            ),
          ],
        ),
      ],
    );

    return Container(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(22),
      ),
      child: body,
    );
  }

  Widget _actionsPanel({required bool expand}) {
    final tiles = <Widget>[
      if (_bridge.status != NodeStatus.running)
        _ActionTile(
          icon: Icons.play_arrow_rounded,
          title: 'Démarrer le serveur',
          subtitle: _busy ? 'Démarrage…' : (_bridge.lastError ?? 'Le serveur n’est pas lancé'),
          highlighted: true,
          onTap: _busy ? null : _startServer,
        )
      else
        _ActionTile(
          icon: Icons.monitor_outlined,
          title: 'Ouvrir le récepteur',
          subtitle: 'Caméra et micro',
          highlighted: true,
          onTap: _openReceiver,
        ),
      _ActionTile(
        icon: Icons.wifi_rounded,
        title: 'Wi-Fi local',
        subtitle: 'copier $_localHost',
        onTap: () => _copy(_bridge.localUrl, done: 'Lien local copié'),
      ),
      _ActionTile(
        icon: Icons.system_update_alt_rounded,
        title: 'Mises à jour',
        subtitle: _updateAvailable ? 'Une mise à jour est disponible' : _updateText,
        onTap: () => setState(() => _updatesOpen = !_updatesOpen),
        extra: _updatesOpen
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 10),
                  Text(_updateText, style: const TextStyle(color: Colors.white, height: 1.3)),
                  const SizedBox(height: 10),
                  OutlinedButton(
                    onPressed: _updateBusy ? null : _checkUpdate,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.white,
                      side: const BorderSide(color: Color(0x55FFFFFF)),
                    ),
                    child: Text(_updateBusy ? 'Vérification…' : 'Vérifier'),
                  ),
                  if (_updateAvailable) ...[
                    const SizedBox(height: 8),
                    FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: _accent),
                      onPressed: _updateBusy ? null : _applyUpdate,
                      child: const Text('Installer la mise à jour'),
                    ),
                  ],
                ],
              )
            : null,
      ),
    ];

    final list = expand
        ? Column(
            children: [
              for (var i = 0; i < tiles.length; i++) ...[
                if (i > 0) const SizedBox(height: 12),
                Expanded(child: tiles[i]),
              ],
            ],
          )
        : Column(
            children: [
              for (var i = 0; i < tiles.length; i++) ...[
                if (i > 0) const SizedBox(height: 12),
                tiles[i],
              ],
            ],
          );

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(22),
      ),
      child: list,
    );
  }
}

class _PairDigits extends StatelessWidget {
  const _PairDigits({required this.code});

  final String? code;

  @override
  Widget build(BuildContext context) {
    final raw = (code != null && code!.length >= 4) ? code! : '------';
    final padded = raw.padRight(6, '-').substring(0, 6);
    final chars = padded.split('');
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < chars.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Container(
            width: 42,
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xFF0F121A),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFF2A3142)),
            ),
            child: Text(
              chars[i],
              style: const TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w800,
                letterSpacing: 0,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.ok});

  final String label;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF0F121A),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF2A3142)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: ok ? Colors.white : _muted,
        ),
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.onTap,
    this.highlighted = false,
    this.extra,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final bool highlighted;
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final fg = highlighted ? Colors.white : Colors.white;
    final sub = highlighted ? Colors.white.withValues(alpha: 0.85) : _muted;
    return Material(
      color: highlighted ? _accent : _tile,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: extra == null ? MainAxisAlignment.center : MainAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, color: fg, size: 28),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: TextStyle(
                            color: fg,
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          subtitle,
                          maxLines: extra == null ? 2 : 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: sub, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              ?extra,
            ],
          ),
        ),
      ),
    );
  }
}
