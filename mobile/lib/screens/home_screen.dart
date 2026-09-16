import 'dart:async';

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
  StreamSubscription<GithubUpdateProgress>? _progressSub;
  bool _busy = false;
  bool _updateBusy = false;
  bool _applying = false;
  bool _updateAvailable = false;
  double _updatePct = 0;
  String _updateText = 'Vérifie les releases GitHub.';

  @override
  void initState() {
    super.initState();
    _progressSub = GithubUpdateService.instance.progress.listen((p) {
      if (!mounted) return;
      setState(() {
        _updatePct = p.pct;
        if (p.label.isNotEmpty) _updateText = p.label;
      });
    });
    _boot();
  }

  @override
  void dispose() {
    _progressSub?.cancel();
    super.dispose();
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
      final s = await GithubUpdateService.instance.check();
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
      _applying = true;
      _updatePct = 0.02;
      _updateText = 'Téléchargement GitHub…';
    });
    try {
      final s = await GithubUpdateService.instance.apply();
      if (!mounted) return;
      setState(() {
        _updateAvailable = s.available;
        _updateText = s.message;
        if (s.ok) _updatePct = 1;
      });
      if (s.ok && s.install) {
        setState(() => _updateText = s.message);
        return;
      }
      if (s.ok && s.restart) {
        setState(() => _updateText = 'Redémarrage de l’app…');
        await Future<void>.delayed(const Duration(milliseconds: 400));
        await const MethodChannel('gamelle/lifecycle').invokeMethod<void>('restartApp');
        return;
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _updateAvailable = false;
        _updateText = 'Échec de la mise à jour.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _updateBusy = false;
          _applying = false;
        });
      }
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

  Future<void> _showLocalWifi() async {
    final url = _bridge.localUrl;
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          backgroundColor: _card,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          title: const Row(
            children: [
              Icon(Icons.wifi_rounded, color: _accent),
              SizedBox(width: 10),
              Text('Wi-Fi local'),
            ],
          ),
          content: SelectableText(
            url,
            style: const TextStyle(color: _accent, fontSize: 16, height: 1.4),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Fermer', style: TextStyle(color: _muted)),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: _accent),
              onPressed: () {
                Navigator.of(ctx).pop();
                _copy(url, done: 'Lien local copié');
              },
              child: const Text('Copier'),
            ),
          ],
        );
      },
    );
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
                  onPressed: _applying ? null : _quit,
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
    final qrSize = expand ? 260.0 : 220.0;
    final qrFace = remote == null
        ? SizedBox(
            width: qrSize,
            height: qrSize,
            child: const Center(child: CircularProgressIndicator(color: _accent)),
          )
        : GestureDetector(
            onTap: () => _copy(remote),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: ScanQr(data: remote, size: qrSize),
            ),
          );
    final qr = Stack(
      clipBehavior: Clip.none,
      children: [
        qrFace,
        Positioned(
          right: 8,
          top: 8,
          child: Material(
            color: _card,
            shape: const CircleBorder(),
            elevation: 2,
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _applying ? null : _showLocalWifi,
              child: const Padding(
                padding: EdgeInsets.all(8),
                child: Icon(Icons.wifi_rounded, color: _accent, size: 22),
              ),
            ),
          ),
        ),
      ],
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
            _StatusPill(label: _localOk ? 'Local OK' : 'Local…', ok: _localOk),
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
          onTap: (_busy || _applying) ? null : _startServer,
        )
      else
        _ActionTile(
          icon: Icons.monitor_outlined,
          title: 'Ouvrir le récepteur',
          subtitle: 'Caméra et micro',
          highlighted: true,
          onTap: _applying ? null : _openReceiver,
        ),
      _ActionTile(
        icon: Icons.system_update_alt_rounded,
        title: 'Mises à jour',
        subtitle: _updateText,
        onTap: _applying
            ? null
            : () {
                if (_updateAvailable) {
                  _applyUpdate();
                } else {
                  _checkUpdate();
                }
              },
        extra: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_applying || _updateBusy) ...[
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(
                  value: _applying ? _updatePct.clamp(0, 1) : null,
                  minHeight: 8,
                  color: _accent,
                  backgroundColor: const Color(0x33FFFFFF),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _applying ? '${(_updatePct * 100).round()} % — $_updateText' : _updateText,
                style: const TextStyle(color: Colors.white, fontSize: 13),
              ),
            ],
            if (!_applying) ...[
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
          ],
        ),
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
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
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
    final fg = Colors.white;
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
                          style: TextStyle(color: fg, fontSize: 17, fontWeight: FontWeight.w700),
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
