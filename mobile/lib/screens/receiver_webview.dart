import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../services/node_bridge_service.dart';
import '../widgets/scan_qr.dart';

const _bg = Color(0xFF0B0D12);
const _card = Color(0xFF151821);
const _accent = Color(0xFFFF7A45);

class ReceiverWebView extends StatefulWidget {
  const ReceiverWebView({
    super.key,
    required this.url,
    this.onChangeUrl,
  });

  final String url;
  final Future<void> Function(String url)? onChangeUrl;

  @override
  State<ReceiverWebView> createState() => _ReceiverWebViewState();
}

class _ReceiverWebViewState extends State<ReceiverWebView>
    with WidgetsBindingObserver {
  static const _native = MethodChannel('gamelle/webview');
  static const _events = EventChannel('gamelle/webview_events');
  static const _life = MethodChannel('gamelle/lifecycle');

  WebViewController? _web;
  StreamSubscription<NodeBridgeMessage>? _urlSub;
  StreamSubscription<dynamic>? _rendererSub;
  int? _webId;
  int _generation = 0;
  double _progress = 0;
  bool _failed = false;
  String _statusHint = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_life.invokeMethod<void>('keepAlive', {'camera': true}));
    _rendererSub = _events.receiveBroadcastStream().listen((event) {
      final map = event is Map ? Map<String, dynamic>.from(event) : null;
      if (map?['type'] == 'rendererGone') {
        _recoverAfterRendererGone();
      }
    });
    _urlSub = NodeBridgeService.instance.messages.listen((msg) {
      if (msg.tag == 'publicUrl' &&
          msg.message.startsWith('http') &&
          msg.message.contains('.trycloudflare.com') &&
          !msg.message.contains('api.trycloudflare.com')) {
        _injectPublicUrl(msg.message);
        if (mounted) setState(() {});
      }
      if (msg.tag == 'pairCode' || msg.tag == 'localUrl') {
        if (mounted) setState(() {});
      }
    });
    _createController();
  }

  void _createController() {
    final controller = WebViewController();
    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
      platform.setOnPlatformPermissionRequest((request) {
        request.grant();
      });
      _webId = platform.webViewIdentifier;
      unawaited(_native.invokeMethod<void>('protect', _webId));
      unawaited(_native.invokeMethod<void>('audioFocus'));
      Future<void>.delayed(const Duration(milliseconds: 400), () {
        if (!mounted || _webId == null) return;
        unawaited(_native.invokeMethod<void>('protect', _webId));
        unawaited(_native.invokeMethod<void>('audioFocus'));
      });
    }

    controller
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'GamelleHost',
        onMessageReceived: (JavaScriptMessage message) {
          final m = message.message.trim();
          if (m == 'background') {
            unawaited(_life.invokeMethod<void>('keepAlive', {'camera': true}));
            unawaited(_life.invokeMethod<void>('background'));
            return;
          }
          if (m == 'off') {
            unawaited(_life.invokeMethod<void>('screenOff'));
            return;
          }
          if (m == 'on') {
            unawaited(_life.invokeMethod<void>('screenOn'));
          }
        },
      )
      ..setBackgroundColor(_bg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (!mounted) return;
            setState(() => _progress = progress / 100);
          },
          onPageFinished: (_) {
            _injectPublicUrl(NodeBridgeService.instance.publicUrl);
            _unlockWebAudio();
            unawaited(_native.invokeMethod<void>('audioFocus'));
          },
          onWebResourceError: (error) {
            if (!mounted) return;
            if (error.isForMainFrame ?? true) {
              setState(() => _failed = true);
            }
          },
          onSslAuthError: (error) {
            error.proceed();
          },
        ),
      )
      ..loadRequest(Uri.parse(widget.url));

    _web = controller;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(_life.invokeMethod<void>('keepAlive', {'camera': true}));
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.resumed) {
      _keepCameraJs();
    }
  }

  Future<void> _keepCameraJs() async {
    final web = _web;
    if (web == null) return;
    try {
      await web.runJavaScript(
        'if (typeof keepCameraAlive === "function") keepCameraAlive();',
      );
    } catch (_) {}
  }

  Future<void> _unlockWebAudio() async {
    final web = _web;
    if (web == null) return;
    try {
      await web.runJavaScript('''
        if (typeof unlockSoundEngine === 'function') unlockSoundEngine();
        if (typeof unlockTalkAudio === 'function') unlockTalkAudio();
      ''');
    } catch (_) {}
  }

  Future<void> _recoverAfterRendererGone() async {
    if (!mounted) return;
    await _destroyNative();
    setState(() {
      _failed = false;
      _progress = 0;
      _statusHint = 'Page rechargée après une coupure mémoire.';
      _generation++;
      _createController();
    });
  }

  Future<void> _destroyNative() async {
    final id = _webId;
    _webId = null;
    _web = null;
    if (id != null) {
      try {
        await _native.invokeMethod<void>('destroy', id);
      } catch (_) {}
    }
  }

  void _showScanQr() {
    final url = NodeBridgeService.instance.controllerShareUrl;
    if (url == null) return;
    showDialog<void>(
      context: context,
      builder: (ctx) {
        return Theme(
          data: ThemeData.light(),
          child: AlertDialog(
            backgroundColor: const Color(0xFFFFFFFF),
            contentPadding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ScanQr(data: url),
                const SizedBox(height: 10),
                const Text(
                  'Scanne avec ton appareil',
                  style: TextStyle(color: Color(0xFF444444), fontSize: 13),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('Fermer'),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _injectPublicUrl(String? url) async {
    final web = _web;
    if (web == null || url == null || !url.startsWith('http')) return;
    final escaped = url.replaceAll(r'\', r'\\').replaceAll("'", r"\'");
    try {
      await web.runJavaScript('''
        window.__GAMELLE_PUBLIC_URL__ = '$escaped';
        if (typeof refreshControllerLink === 'function') {
          refreshControllerLink();
        } else if (typeof applyRemoteOrigin === 'function') {
          applyRemoteOrigin(window.__GAMELLE_PUBLIC_URL__);
        }
      ''');
    } catch (_) {}
  }

  @override
  void dispose() {
    _urlSub?.cancel();
    _rendererSub?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_destroyNative());
    super.dispose();
  }

  Future<void> _showControllerLink() async {
    final url = NodeBridgeService.instance.controllerShareUrl;
    if (url == null) return;
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          backgroundColor: _card,
          title: const Text('Lien du contrôleur'),
          content: SelectableText(
            url,
            style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.4),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: url));
                if (ctx.mounted) Navigator.of(ctx).pop();
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Lien copié')),
                );
              },
              child: const Text('Copier'),
            ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Fermer'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    final hasShare = NodeBridgeService.instance.controllerShareUrl != null;
    return PopScope(
      canPop: true,
      child: Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  _TopBtn(
                    label: 'Retour',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  _TopBtn(
                    label: 'QR',
                    onPressed: hasShare ? _showScanQr : null,
                  ),
                  _TopBtn(
                    label: 'Lien',
                    accent: true,
                    onPressed: hasShare ? _showControllerLink : null,
                  ),
                ],
              ),
            ),
            if (_statusHint.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(
                  _statusHint,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Color(0xFF888888), fontSize: 12),
                ),
              ),
            if (_progress > 0 && _progress < 1)
              LinearProgressIndicator(
                value: _progress,
                color: _accent,
                backgroundColor: _card,
                minHeight: 2,
              ),
            Expanded(
              child: _failed || web == null
                  ? _ErrorPane(
                      url: widget.url,
                      onRetry: () {
                        setState(() {
                          _failed = false;
                          _generation++;
                          _createController();
                        });
                      },
                      onChangeUrl: widget.onChangeUrl,
                    )
                  : WebViewWidget(
                      key: ValueKey<int>(_generation),
                      controller: web,
                    ),
            ),
          ],
        ),
      ),
      ),
    );
  }
}

class _TopBtn extends StatelessWidget {
  const _TopBtn({
    required this.label,
    this.onPressed,
    this.accent = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null;
    return Material(
      color: accent ? _accent : const Color(0xFF1C2030),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(12),
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Text(
              label,
              style: TextStyle(
                color: accent ? const Color(0xFF111111) : Colors.white,
                fontWeight: FontWeight.w700,
                fontSize: 14,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorPane extends StatelessWidget {
  const _ErrorPane({
    required this.url,
    required this.onRetry,
    this.onChangeUrl,
  });

  final String url;
  final VoidCallback onRetry;
  final Future<void> Function(String url)? onChangeUrl;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.wifi_off, size: 48, color: _accent),
          const SizedBox(height: 16),
          const Text(
            'Serveur injoignable',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            url,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFF888888)),
          ),
          const SizedBox(height: 24),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _accent),
            onPressed: onRetry,
            child: const Text('Réessayer'),
          ),
          if (onChangeUrl != null) ...[
            const SizedBox(height: 8),
            TextButton(
              onPressed: () {
                Navigator.of(context).maybePop();
                onChangeUrl!('');
              },
              child: const Text('Retour'),
            ),
          ],
        ],
      ),
    );
  }
}
