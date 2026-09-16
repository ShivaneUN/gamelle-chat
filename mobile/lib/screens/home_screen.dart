import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../services/github_update_service.dart';
import '../services/node_bridge_service.dart';
import '../widgets/scan_qr.dart';
import 'receiver_webview.dart';

const _bg = Color(0xFF10131A);
const _card = Color(0xFF1A1E29);
const _accent = Color(0xFFFF7A45);

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
  String _updateText = 'Vérifie les releases GitHub.';

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
      _updateText = 'Téléchargement GitHub…';
    });
    try {
      final s = await GithubUpdateService.instance.apply();
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

  String get _statusLabel {
    switch (_bridge.status) {
      case NodeStatus.idle:
        return 'Arrêté';
      case NodeStatus.starting:
        return 'Démarrage du serveur…';
      case NodeStatus.running:
        if (_bridge.publicUrl != null) {
          return 'Local OK · Cloudflare OK';
        }
        if (_bridge.tunnelError != null) {
          return 'Local OK · Cloudflare : ${_bridge.tunnelError}';
        }
        return 'Serveur local en cours · tunnel en attente';
      case NodeStatus.error:
        return _bridge.lastError ?? 'Erreur serveur';
    }
  }

  Color get _statusColor {
    switch (_bridge.status) {
      case NodeStatus.running:
        return _accent;
      case NodeStatus.error:
        return const Color(0xFFFF5A5A);
      default:
        return const Color(0xFF888888);
    }
  }

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

  Future<void> _copy(String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Lien copié')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final local = _bridge.localUrl;
    final remote = _bridge.publicUrl;
    final pair = _bridge.pairCode;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _goBackground();
      },
      child: Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Text(
              'Gamelle Chat',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Text(
              _statusLabel,
              textAlign: TextAlign.center,
              style: TextStyle(color: _statusColor),
            ),
            const SizedBox(height: 24),
            _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'QR Contrôleur (Cloudflare)',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 12),
                  if (remote != null)
                    Center(child: ScanQr(data: remote))
                  else
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: CircularProgressIndicator(color: _accent),
                      ),
                    ),
                  if (pair != null && pair.length >= 4) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Code : $pair',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 4,
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  Text(
                    remote ??
                        (_bridge.tunnelError ?? 'Ouverture du tunnel Cloudflare…'),
                    style: TextStyle(
                      color: remote == null ? const Color(0xFF888888) : _accent,
                    ),
                  ),
                  if (remote != null)
                    TextButton(
                      onPressed: () => _copy(remote),
                      child: const Text('Copier le lien'),
                    ),
                ],
              ),
            ),
            _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Wi-Fi local', style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text(local, style: const TextStyle(color: _accent)),
                  TextButton(
                    onPressed: () => _copy(local),
                    child: const Text('Copier le lien local'),
                  ),
                ],
              ),
            ),
            _Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Mises à jour GitHub',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  Text(_updateText),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: _updateBusy ? null : _checkUpdate,
                    child: const Text('Vérifier'),
                  ),
                  if (_updateAvailable) ...[
                    const SizedBox(height: 8),
                    FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: _accent),
                      onPressed: _updateBusy ? null : _applyUpdate,
                      child: const Text('Installer la mise à jour'),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 8),
            if (_bridge.status != NodeStatus.running)
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: _accent,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                onPressed: _busy ? null : _startServer,
                child: _busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Démarrer le serveur'),
              ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _openReceiver,
              child: const Text('Ouvrir le récepteur'),
            ),
            const SizedBox(height: 8),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: _accent,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: _goBackground,
              child: const Text('Arrière-plan (caméra continue)'),
            ),
            const SizedBox(height: 8),
            const Text(
              'Sur la tablette sans bouton Accueil : utilise ce bouton. Ne balaye pas l’app dans les applications récentes.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF888888), fontSize: 12),
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: _quit,
              child: const Text('Quitter et arrêter le serveur'),
            ),
          ],
        ),
      ),
    ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(14),
      ),
      child: child,
    );
  }
}
