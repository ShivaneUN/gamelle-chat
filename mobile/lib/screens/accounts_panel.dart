import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

const _bg = Color(0xFF0B0D12);
const _card = Color(0xFF151821);
const _tile = Color(0xFF1C2030);
const _accent = Color(0xFFFF7A45);
const _muted = Color(0xFF8B93A7);

/// Panneau comptes contrôleur — à la place du QR (comme Réglages).
class AccountsPanel extends StatefulWidget {
  const AccountsPanel({
    super.key,
    this.onClose,
    this.embedded = false,
  });

  final VoidCallback? onClose;
  final bool embedded;

  @override
  State<AccountsPanel> createState() => _AccountsPanelState();
}

class _AccountsPanelState extends State<AccountsPanel> {
  final _userCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  final _pass2Ctrl = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;
  List<_AccountRow> _users = const [];

  @override
  void initState() {
    super.initState();
    unawaited(_loadUsers());
  }

  @override
  void dispose() {
    _userCtrl.dispose();
    _passCtrl.dispose();
    _pass2Ctrl.dispose();
    super.dispose();
  }

  /// Toujours loopback : l’API comptes est réservée à isLocalRequest (127.0.0.1).
  /// localUrl LAN (192.168.x) fait échouer la liste → « comptes disparus ».
  Uri _api(String path) {
    return Uri.parse('https://127.0.0.1:3000$path');
  }

  Future<HttpClient> _client() async {
    final client = HttpClient()
      ..badCertificateCallback = (cert, host, port) {
        return host == '127.0.0.1' || host == 'localhost';
      }
      ..connectionTimeout = const Duration(seconds: 5);
    return client;
  }

  Future<Map<String, dynamic>> _json(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = await _client();
    try {
      final req = await client.openUrl(method, _api(path));
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (body != null) {
        final raw = utf8.encode(jsonEncode(body));
        req.headers.set(HttpHeaders.contentTypeHeader, 'application/json; charset=utf-8');
        req.contentLength = raw.length;
        req.add(raw);
      }
      final res = await req.close().timeout(const Duration(seconds: 8));
      final text = await res.transform(utf8.decoder).join();
      Map<String, dynamic> map = {};
      try {
        final decoded = jsonDecode(text);
        if (decoded is Map) map = Map<String, dynamic>.from(decoded);
      } catch (_) {}
      map['_status'] = res.statusCode;
      return map;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> _loadUsers() async {
    try {
      final map = await _json('GET', '/api/auth/users');
      if (!mounted) return;
      if (map['_status'] != 200) {
        setState(() {
          _error = '${map['error'] ?? 'Impossible de charger les comptes'}';
        });
        return;
      }
      final list = map['users'];
      final rows = <_AccountRow>[];
      if (list is List) {
        for (final item in list) {
          if (item is! Map) continue;
          final id = '${item['id'] ?? ''}';
          final username = '${item['username'] ?? ''}';
          if (id.isEmpty || username.isEmpty) continue;
          rows.add(_AccountRow(id: id, username: username));
        }
      }
      setState(() {
        _users = rows;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Serveur injoignable — démarre le serveur.');
    }
  }

  Future<void> _create() async {
    if (_busy) return;
    final username = _userCtrl.text.trim();
    final pass = _passCtrl.text;
    final pass2 = _pass2Ctrl.text;
    if (username.length < 2) {
      setState(() => _error = 'Identifiant trop court (min. 2).');
      return;
    }
    if (pass.length < 4) {
      setState(() => _error = 'Mot de passe trop court (min. 4).');
      return;
    }
    if (pass != pass2) {
      setState(() => _error = 'Les mots de passe ne correspondent pas.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final map = await _json('POST', '/api/auth/register', body: {
        'username': username,
        'password': pass,
      });
      if (!mounted) return;
      if (map['_status'] != 200 && map['_status'] != 201) {
        setState(() => _error = '${map['error'] ?? 'Création impossible'}');
        return;
      }
      _userCtrl.clear();
      _passCtrl.clear();
      _pass2Ctrl.clear();
      await _loadUsers();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Compte « $username » créé')),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Création impossible.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(_AccountRow row) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _card,
        title: const Text('Supprimer le compte ?', style: TextStyle(color: Colors.white)),
        content: Text(
          '« ${row.username} » ne pourra plus se connecter au contrôleur.',
          style: const TextStyle(color: _muted),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Supprimer', style: TextStyle(color: _accent)),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final map = await _json('DELETE', '/api/auth/users/${row.id}');
      if (!mounted) return;
      if (map['_status'] != 200) {
        setState(() => _error = '${map['error'] ?? 'Suppression impossible'}');
        return;
      }
      await _loadUsers();
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Suppression impossible.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  InputDecoration _fieldDecoration(String label, {Widget? suffix}) {
    return InputDecoration(
      labelText: label,
      labelStyle: const TextStyle(color: _muted),
      filled: true,
      fillColor: _tile,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
      suffixIcon: suffix,
    );
  }

  @override
  Widget build(BuildContext context) {
    final body = <Widget>[
      if (widget.embedded) ...[
        Row(
          children: [
            const Expanded(
              child: Text(
                'Comptes',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (widget.onClose != null)
              IconButton(
                tooltip: 'Fermer',
                onPressed: widget.onClose,
                icon: const Icon(Icons.close_rounded, color: Colors.white),
              ),
          ],
        ),
        const SizedBox(height: 8),
      ],
      const Text(
        'Seuls ces comptes peuvent ouvrir le contrôleur (lien web).',
        style: TextStyle(color: _muted, fontSize: 13, height: 1.35),
      ),
      const SizedBox(height: 12),
      Container(
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(22),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (var i = 0; i < _users.length; i++) ...[
              if (i > 0) const Divider(height: 1, color: Color(0xFF2A3142)),
              ListTile(
                tileColor: _tile,
                title: Text(
                  _users[i].username,
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
                ),
                trailing: IconButton(
                  tooltip: 'Supprimer',
                  onPressed: _busy ? null : () => _delete(_users[i]),
                  icon: const Icon(Icons.delete_outline_rounded, color: _accent),
                ),
              ),
            ],
            if (_users.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Aucun compte — crée-en un ci-dessous.',
                  style: TextStyle(color: _muted),
                ),
              ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      TextField(
        controller: _userCtrl,
        style: const TextStyle(color: Colors.white),
        autocorrect: false,
        enableSuggestions: false,
        decoration: _fieldDecoration('Identifiant'),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _passCtrl,
        obscureText: _obscure,
        style: const TextStyle(color: Colors.white),
        autocorrect: false,
        enableSuggestions: false,
        decoration: _fieldDecoration(
          'Mot de passe',
          suffix: IconButton(
            onPressed: () => setState(() => _obscure = !_obscure),
            icon: Icon(
              _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
              color: _muted,
            ),
          ),
        ),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _pass2Ctrl,
        obscureText: _obscure,
        style: const TextStyle(color: Colors.white),
        autocorrect: false,
        enableSuggestions: false,
        decoration: _fieldDecoration('Confirmer le mot de passe'),
      ),
      if (_error != null) ...[
        const SizedBox(height: 10),
        Text(_error!, style: const TextStyle(color: _accent, fontSize: 13)),
      ],
      const SizedBox(height: 14),
      FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: _accent,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(46),
        ),
        onPressed: _busy ? null : _create,
        child: Text(_busy ? 'Création…' : 'Créer le compte'),
      ),
    ];

    if (widget.embedded) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: body,
      );
    }

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: _bg,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text('Comptes'),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: body,
      ),
    );
  }
}

class _AccountRow {
  const _AccountRow({required this.id, required this.username});
  final String id;
  final String username;
}
