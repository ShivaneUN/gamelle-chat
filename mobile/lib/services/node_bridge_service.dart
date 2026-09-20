import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:node_flutter/node_flutter.dart';

import 'cloudflare_tunnel.dart';

enum NodeStatus { idle, starting, running, error }

class NodeBridgeMessage {
  const NodeBridgeMessage({required this.tag, required this.message});

  final String tag;
  final String message;
}

/// Encapsule node_flutter (start / messages). Pas d’arrêt natif dans le plugin.
class NodeBridgeService {
  NodeBridgeService._();
  static final NodeBridgeService instance = NodeBridgeService._();

  NodeStatus status = NodeStatus.idle;
  bool get running => status == NodeStatus.running;
  String? lastError;
  String localUrl = 'https://127.0.0.1:3000';
  String? publicUrl;
  String? pairCode;
  String? tunnelError;
  bool tunnelEnabled = true;

  String? get controllerPublicUrl {
    final base = publicUrl;
    if (base == null || base.isEmpty) return null;
    return base.replaceAll(RegExp(r'/$'), '');
  }

  String? get controllerShareUrl => scannableQrUrl;

  String? get scannableQrUrl {
    final raw = publicUrl;
    if (raw == null || raw.isEmpty) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null) return null;
    if (uri.scheme != 'https' && uri.scheme != 'http') return null;
    final host = uri.host;
    if (host.isEmpty || host == 'localhost' || host == '127.0.0.1' || host == '::1') {
      return null;
    }
    if (host == 'api.trycloudflare.com') return null;
    if (!_isAllowedPublicHost(host)) return null;
    final base = raw.replaceAll(RegExp(r'/$'), '');
    // Même URL que le QR HTML : ouvre directement le contrôleur.
    return '$base/controller.html';
  }

  final _controller = StreamController<NodeBridgeMessage>.broadcast();
  StreamSubscription<Map<String, dynamic>>? _sub;
  StreamSubscription<Map<String, dynamic>>? _tunnelSub;
  bool _infoPollStarted = false;
  bool _tunnelStarted = false;
  bool _pollStarted = false;

  Future<void> _pollServerInfo() async {
    if (_infoPollStarted) return;
    _infoPollStarted = true;
    final client = HttpClient()
      ..badCertificateCallback = (cert, host, port) {
        return host == '127.0.0.1' || host == 'localhost';
      }
      ..connectionTimeout = const Duration(seconds: 2);
    try {
      while (status == NodeStatus.running) {
        try {
          final req = await client.getUrl(Uri.parse('https://127.0.0.1:3000/api/info'));
          final res = await req.close().timeout(const Duration(seconds: 3));
          final body = await res.transform(utf8.decoder).join();
          final json = jsonDecode(body);
          if (json is Map) {
            final code = '${json['pairCode'] ?? ''}';
            if (code.length >= 4 && pairCode != code) {
              pairCode = code;
              _controller.add(NodeBridgeMessage(tag: 'pairCode', message: code));
            }
            final url = '${json['publicUrl'] ?? ''}';
            if (_isAllowedPublicUrl(url) && publicUrl != url) {
              publicUrl = url;
              _controller.add(NodeBridgeMessage(tag: 'publicUrl', message: url));
            }
          }
        } catch (_) {}
        await Future<void>.delayed(const Duration(seconds: 2));
      }
    } finally {
      client.close(force: true);
      _infoPollStarted = false;
    }
  }

  Stream<NodeBridgeMessage> get messages => _controller.stream;

  bool _isAllowedPublicHost(String host) {
    final h = host.toLowerCase();
    if (h.isEmpty || h == 'api.trycloudflare.com') return false;
    if (h == 'juvana.cc' || h.endsWith('.juvana.cc')) return true;
    return h.endsWith('.trycloudflare.com');
  }

  bool _isAllowedPublicUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.host.isEmpty) return false;
    return _isAllowedPublicHost(uri.host);
  }

  void _emit(String tag, String message) {
    if (tag == 'publicUrl') {
      if (!_isAllowedPublicUrl(message)) return;
      publicUrl = message;
      unawaited(_persistPublicUrl(message));
    }
    if (tag == 'localUrl' && message.startsWith('http')) {
      localUrl = message;
    }
    if (tag == 'node' && message == 'LISTENING') {
      status = NodeStatus.running;
      lastError = null;
      _startTunnel();
      unawaited(_pollServerInfo());
    }
    if (tag == 'node' && message.startsWith('ERROR')) {
      status = NodeStatus.error;
      lastError = message;
    }
    if (tag == 'screen') {
      final cmd = message == 'off' ? 'screenOff' : 'screenOn';
      unawaited(const MethodChannel('gamelle/lifecycle').invokeMethod<void>(cmd));
    }
    if (tag == 'alarm') {
      unawaited(const MethodChannel('gamelle/lifecycle').invokeMethod<void>('screenOn'));
      unawaited(
        const MethodChannel('gamelle/lifecycle').invokeMethod<void>('alarmShow', message),
      );
    }
    if (tag == 'alarm-stop') {
      unawaited(const MethodChannel('gamelle/lifecycle').invokeMethod<void>('alarmHide'));
    }
    _controller.add(NodeBridgeMessage(tag: tag, message: message));
  }

  Future<void> _ensureListener() async {
    if (_sub != null) return;
    _sub = Nodejs.onMessageReceived.listen((event) {
      final tag = '${event['tag'] ?? event['channelName'] ?? ''}';
      final message = '${event['message'] ?? ''}';
      _emit(tag, message);
    });
  }

  Future<void> _waitForCopiedAssets() async {
    try {
      final path = await Nodejs.getNodeJsProjectPath();
      if (path == null || path.isEmpty) return;
      final main = File('$path${Platform.pathSeparator}main.js');
      for (var i = 0; i < 40; i++) {
        if (await main.exists()) return;
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
    } catch (_) {}
  }

  Future<void> _pollUntilListening() async {
    if (_pollStarted) return;
    _pollStarted = true;
    final client = HttpClient()
      ..badCertificateCallback = (cert, host, port) {
        return host == '127.0.0.1' || host == 'localhost';
      }
      ..connectionTimeout = const Duration(seconds: 2);
    try {
      for (var i = 0; i < 50; i++) {
        if (status == NodeStatus.running) return;
        try {
          final req = await client.getUrl(Uri.parse('https://127.0.0.1:3000'));
          final res = await req.close().timeout(const Duration(seconds: 3));
          await res.drain<void>();
          if (status != NodeStatus.running) {
            _emit('node', 'LISTENING');
          }
          return;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 400));
        }
      }
      if (status != NodeStatus.running && status != NodeStatus.error) {
        _emit('node', 'ERROR Le serveur Node n’écoute pas sur https://127.0.0.1:3000');
      }
    } finally {
      client.close(force: true);
    }
  }

  Future<Directory?> _persistDataDir() async {
    final root = await Nodejs.getNodeJsProjectPath();
    if (root == null || root.isEmpty) return null;
    return Directory(
      '${Directory(root).parent.path}${Platform.pathSeparator}gamelle-persist${Platform.pathSeparator}data',
    );
  }

  Future<void> _persistPublicUrl(String url) async {
    try {
      final dir = await _persistDataDir();
      if (dir == null) return;
      if (!await dir.exists()) await dir.create(recursive: true);
      await File('${dir.path}${Platform.pathSeparator}public-url.json')
          .writeAsString(jsonEncode({'url': url}));
    } catch (_) {}
  }

  Future<void> _clearStalePublicUrl() async {
    publicUrl = null;
    try {
      final dir = await _persistDataDir();
      if (dir == null) return;
      final file = File('${dir.path}${Platform.pathSeparator}public-url.json');
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  Future<void> _startTunnel() async {
    if (!tunnelEnabled) return;
    if (_tunnelStarted) return;
    _tunnelStarted = true;
    await _clearStalePublicUrl();
    _tunnelSub ??= CloudflareTunnel.events().listen((event) {
      final type = '${event['type'] ?? ''}';
      final value = '${event['value'] ?? ''}';
      if (type == 'url' && _isAllowedPublicUrl(value)) {
        publicUrl = value;
        tunnelError = null;
        unawaited(_persistPublicUrl(value));
        _controller.add(NodeBridgeMessage(tag: 'publicUrl', message: value));
      } else if (type == 'error') {
        if (publicUrl != null) return;
        tunnelError = value;
        // Allow a later retry from settings / restart.
        _tunnelStarted = false;
        _controller.add(NodeBridgeMessage(tag: 'tunnelError', message: value));
      }
    });
    try {
      await CloudflareTunnel.start();
    } catch (e) {
      tunnelError = e.toString();
      _tunnelStarted = false;
      _controller.add(NodeBridgeMessage(tag: 'tunnelError', message: tunnelError!));
    }
  }

  Future<void> _stopTunnel() async {
    try {
      await CloudflareTunnel.stop();
    } catch (_) {}
    publicUrl = null;
    tunnelError = null;
    _tunnelStarted = false;
    await _clearStalePublicUrl();
    _controller.add(const NodeBridgeMessage(tag: 'publicUrl', message: ''));
  }

  /// Active ou coupe le tunnel Cloudflare sans toucher au serveur Node.
  Future<void> setTunnelEnabled(bool enabled) async {
    if (tunnelEnabled == enabled) {
      if (!enabled) return;
      if (_tunnelStarted || status != NodeStatus.running) return;
    }
    tunnelEnabled = enabled;
    if (!enabled) {
      await _stopTunnel();
      _controller.add(const NodeBridgeMessage(tag: 'tunnel', message: 'off'));
      return;
    }
    if (status == NodeStatus.running) {
      await _startTunnel();
    }
    _controller.add(const NodeBridgeMessage(tag: 'tunnel', message: 'on'));
  }

  /// Lance Node.js (Foreground Service, sinon dans le process Flutter).
  Future<bool> start() async {
    if (status == NodeStatus.running) return true;
    if (status == NodeStatus.starting) return true;
    lastError = null;
    status = NodeStatus.starting;
    _pollStarted = false;
    await _ensureListener();
    await _waitForCopiedAssets();
    try {
      await const MethodChannel('gamelle/github').invokeMethod<void>('applyOverlay');
    } catch (_) {}
    try {
      try {
        await Nodejs.startService(
          'main.js',
          title: 'Gamelle Chat',
          content: 'Serveur en cours',
        );
      } catch (_) {
        await Nodejs.start(fileName: 'main.js');
      }
      unawaited(_pollUntilListening());
      return true;
    } catch (e) {
      status = NodeStatus.error;
      lastError = e.toString();
      return false;
    }
  }

  Future<void> send(String tag, String message) {
    return Nodejs.sendMessage(tag, message);
  }

  Future<String?> projectPath() => Nodejs.getNodeJsProjectPath();

  /// Arrête Node + tunnel sans quitter l’app.
  Future<void> stop() async {
    await _stopTunnel();
    try {
      await const MethodChannel('gamelle/github').invokeMethod<void>('stopNode');
    } catch (_) {}
    status = NodeStatus.idle;
    lastError = null;
    _pollStarted = false;
    _infoPollStarted = false;
    pairCode = null;
    _controller.add(const NodeBridgeMessage(tag: 'node', message: 'STOPPED'));
  }

  /// Relance Node après une mise à jour GitHub, sans tuer l’app.
  Future<bool> restartAfterUpdate() async {
    await stop();
    await Future<void>.delayed(const Duration(milliseconds: 900));
    return start();
  }

  /// Coupe tunnel + service Node. L’activité native tue ensuite le process.
  Future<void> shutdown() async {
    try {
      await CloudflareTunnel.stop();
    } catch (_) {}
    try {
      await const MethodChannel('gamelle/lifecycle').invokeMethod<void>('shutdown');
    } catch (_) {}
    status = NodeStatus.idle;
    publicUrl = null;
    _tunnelStarted = false;
    _pollStarted = false;
    _infoPollStarted = false;
    pairCode = null;
  }
}
