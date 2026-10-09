import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

import '../services/cloudflare_tunnel.dart';
import '../services/node_bridge_service.dart';

const _bg = Color(0xFF0B0D12);
const _card = Color(0xFF151821);
const _tile = Color(0xFF1C2030);
const _accent = Color(0xFFFF7A45);
const _muted = Color(0xFF8B93A7);
const _ok = Color(0xFF3DDC97);

/// Panneau réglages (serveur, Cloudflare, mon domaine, notifs) —
/// page pleine ou panneau gauche de l’accueil (à la place du QR).
class SettingsPanel extends StatefulWidget {
  const SettingsPanel({
    super.key,
    this.onClose,
    this.embedded = false,
  });

  final VoidCallback? onClose;
  final bool embedded;

  @override
  State<SettingsPanel> createState() => _SettingsPanelState();
}

class _SettingsPanelState extends State<SettingsPanel> {
  final _bridge = NodeBridgeService.instance;
  StreamSubscription<NodeBridgeMessage>? _sub;
  bool _busy = false;
  bool _tunnelBusy = false;
  bool _domainBusy = false;
  PermissionStatus _notifStatus = PermissionStatus.denied;

  bool _domainEnabled = false;
  String _domainUrl = '';
  bool _hasToken = false;
  String _tokenMask = '';
  bool _editingToken = false;
  bool _showToken = true;
  static const _serviceUrl = 'localhost:3001';
  final _urlCtrl = TextEditingController();
  final _tokenCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _sub = _bridge.messages.listen((_) {
      if (mounted) setState(() {});
    });
    _refreshNotif();
    _loadCustomDomain();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _urlCtrl.dispose();
    _tokenCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadCustomDomain() async {
    try {
      final s = await CloudflareTunnel.getCustomDomain();
      if (!mounted) return;
      setState(() {
        _takeDomainStatus(s);
        if (_urlCtrl.text.isEmpty && s.publicUrl.isNotEmpty) {
          _urlCtrl.text = s.publicUrl;
        }
      });
      await _bridge.refreshCustomDomainFlag();
      // Domaine actif → Cloudflare libre OFF.
      if (s.enabled && s.hasToken && s.publicUrl.isNotEmpty && _bridge.tunnelEnabled) {
        _bridge.tunnelEnabled = false;
        if (mounted) setState(() {});
      }
    } catch (_) {}
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
      if (on && _domainEnabled) {
        // Libre ON → Mon domaine OFF automatiquement.
        await CloudflareTunnel.setCustomDomain(enabled: false);
        if (mounted) {
          setState(() => _domainEnabled = false);
        }
        await _bridge.refreshCustomDomainFlag();
      }
      await _bridge.setTunnelEnabled(on);
    } finally {
      if (mounted) setState(() => _tunnelBusy = false);
    }
  }

  Future<void> _applyDomain({
    bool? enabled,
    String? publicUrl,
    String? token,
    bool clearToken = false,
  }) async {
    if (_domainBusy) return;
    setState(() => _domainBusy = true);
    try {
      final nextEnabled = enabled ?? _domainEnabled;
      final CustomDomainStatus s;
      if (clearToken) {
        s = await CloudflareTunnel.clearCustomDomainToken();
      } else {
        s = await CloudflareTunnel.setCustomDomain(
          enabled: nextEnabled,
          publicUrl: publicUrl,
          token: token,
        );
      }
      if (!mounted) return;
      setState(() {
        _takeDomainStatus(s);
        _editingToken = false;
        _tokenCtrl.clear();
        if (s.publicUrl.isNotEmpty) _urlCtrl.text = s.publicUrl;
      });

      final domainLive = s.enabled && s.hasToken && s.publicUrl.isNotEmpty;
      if (domainLive) {
        // Mon domaine ON → Cloudflare libre OFF.
        _bridge.tunnelEnabled = false;
        _bridge.customDomainActive = true;
        await _bridge.restartTunnel(clearPublicUrl: false);
      } else {
        // Mon domaine OFF → Cloudflare libre ON.
        _bridge.customDomainActive = false;
        _bridge.tunnelEnabled = true;
        await _bridge.restartTunnel(clearPublicUrl: true);
      }
      if (mounted) setState(() {});
    } catch (e) {
      if (!mounted) return;
      setState(() => _showToken = true);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_domainErrorText(e))),
      );
    } finally {
      if (mounted) setState(() => _domainBusy = false);
    }
  }

  Future<void> _toggleDomain(bool on) async {
    final url = _urlCtrl.text.trim().isNotEmpty ? _urlCtrl.text.trim() : _domainUrl;
    if (on && url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Indique d’abord ton lien domaine.')),
      );
      return;
    }
    if (on && !_hasToken && _tokenCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Ajoute d’abord le token tunnel.')),
      );
      return;
    }
    final token = _tokenReadyForSave();
    if (token == null && _tokenCtrl.text.trim().isNotEmpty) return;
    await _applyDomain(enabled: on, publicUrl: url, token: token);
  }

  Future<void> _saveUrl() async {
    final url = _urlCtrl.text.trim();
    if (url.isEmpty) return;
    await _applyDomain(enabled: _domainEnabled, publicUrl: url);
  }

  /// Le token Cloudflare est une longue ligne sans espace. On retire
  /// les retours à la ligne d’un collage, et la commande `--token` si elle est collée avec.
  String _cleanToken(String raw) {
    var t = raw.trim();
    final quoted = RegExp("^['\"](.+)['\"]\$").firstMatch(t);
    if (quoted != null) t = quoted.group(1)!.trim();
    final flagged = RegExp(r'--token(?:=|\s+)(\S+)').firstMatch(t);
    if (flagged != null) t = flagged.group(1)!;
    return t.replaceAll(RegExp(r'\s+'), '');
  }

  String _domainErrorText(Object e) {
    final s = e.toString();
    if (s.contains('Token trop court')) {
      return 'Token trop court. Colle le token Cloudflare en entier : une longue ligne, pas l’identifiant du tunnel.';
    }
    if (s.contains('URL invalide')) return 'Lien de domaine invalide.';
    return 'Domaine : $s';
  }

  void _rejectShortToken(int length) {
    setState(() => _showToken = true);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Token trop court : $length caractères. Le token Cloudflare est une longue ligne, en général plus de 100 caractères. Une ligne courte avec des tirets est l’identifiant du tunnel, pas le token.',
        ),
      ),
    );
  }

  /// null si le champ est vide. Le champ reste affiché si le token est trop court.
  String? _tokenReadyForSave() {
    final typed = _tokenCtrl.text;
    if (typed.trim().isEmpty) return null;
    final token = _cleanToken(typed);
    if (token != typed) {
      _tokenCtrl.value = TextEditingValue(
        text: token,
        selection: TextSelection.collapsed(offset: token.length),
      );
    }
    if (token.length < 40) {
      _rejectShortToken(token.length);
      return null;
    }
    return token;
  }

  Future<void> _saveToken() async {
    final token = _tokenReadyForSave();
    if (token == null) return;
    await _applyDomain(
      enabled: _domainEnabled,
      publicUrl: _urlCtrl.text.trim().isNotEmpty ? _urlCtrl.text.trim() : null,
      token: token,
    );
  }

  Future<void> _deleteToken() async {
    await _applyDomain(clearToken: true);
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

  void _takeDomainStatus(CustomDomainStatus s) {
    _domainEnabled = s.enabled;
    _domainUrl = s.publicUrl;
    _hasToken = s.hasToken;
    _tokenMask = s.tokenMask;
  }

  bool get _domainUp {
    if (!_domainEnabled || !_hasToken || _domainUrl.isEmpty) return false;
    final live = _bridge.publicUrl ?? '';
    if (live.isEmpty) return false;
    final err = _bridge.tunnelError;
    return err == null || err.isEmpty;
  }

  String get _domainSubtitle {
    if (!_domainEnabled) {
      return 'Off — Cloudflare libre actif';
    }
    if (_domainUrl.isEmpty) return 'Lien manquant';
    final host = _domainUrl.replaceFirst(RegExp(r'^https?://'), '');
    if (!_hasToken) return '$host — token manquant';
    final err = _bridge.tunnelError;
    if (err != null && err.isNotEmpty) return err;
    return '$host — Cloudflare libre off';
  }

  @override
  Widget build(BuildContext context) {
    final running = _bridge.status == NodeStatus.running;
    final tunnelOn = _bridge.tunnelEnabled;

    final body = <Widget>[
      if (widget.embedded) ...[
        Row(
          children: [
            const Expanded(
              child: Text(
                'Réglages',
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
      _SettingsCard(
        child: Column(
          children: [
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
              title: 'Cloudflare libre',
              subtitle: _domainEnabled
                  ? 'Off — Mon domaine actif'
                  : (!tunnelOn
                      ? 'Désactivé — accès local uniquement'
                      : (_bridge.publicUrl != null
                          ? 'Tunnel actif'
                          : (_bridge.tunnelError ?? 'Connexion…'))),
              trailing: Switch(
                value: tunnelOn && !_domainEnabled,
                activeThumbColor: _accent,
                onChanged: (_tunnelBusy || _domainBusy)
                    ? null
                    : (on) {
                        if (!on && _domainEnabled) return;
                        _toggleTunnel(on);
                      },
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
      const SizedBox(height: 12),
      _SettingsCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _SettingsTile(
              icon: Icons.language_rounded,
              title: 'Mon domaine',
              subtitle: _domainSubtitle,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: 'Aide',
                    onPressed: _showDomainHelp,
                    icon: const Icon(Icons.help_outline_rounded, color: _accent),
                  ),
                  Switch(
                    value: _domainEnabled,
                    activeThumbColor: _accent,
                    onChanged: _domainBusy ? null : _toggleDomain,
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF2A3142)),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _urlCtrl,
                      enabled: !_domainBusy,
                      style: const TextStyle(color: Colors.white, fontSize: 14),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: const InputDecoration(
                        isDense: true,
                        hintText: 'https://ton-domaine.tld',
                        hintStyle: TextStyle(color: _muted),
                        border: InputBorder.none,
                      ),
                      onSubmitted: (_) => _saveUrl(),
                    ),
                  ),
                  IconButton(
                    onPressed: _domainBusy ? null : _saveUrl,
                    icon: const Icon(Icons.check_rounded, color: _accent),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF2A3142)),
            _buildServerHostRow(),
            const Divider(height: 1, color: Color(0xFF2A3142)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: _buildTokenRow(),
            ),
          ],
        ),
      ),
      Padding(
        padding: const EdgeInsets.only(top: 12, left: 4, right: 4),
        child: Text(
          running
              ? 'Le récepteur reste sur cette tablette.'
              : 'Démarre le serveur pour ouvrir le domaine.',
          style: const TextStyle(color: _muted, fontSize: 13),
        ),
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
        title: const Text('Réglages'),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: body,
      ),
    );
  }

  Widget _buildTokenRow() {
    if (_editingToken || !_hasToken) {
      final cleaned = _cleanToken(_tokenCtrl.text);
      final count = cleaned.length;
      final short = count > 0 && count < 40;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: Icon(Icons.lock_outline_rounded, color: Colors.white, size: 22),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _tokenCtrl,
                  enabled: !_domainBusy,
                  obscureText: !_showToken,
                  obscuringCharacter: '•',
                  maxLines: _showToken ? 4 : 1,
                  enableSuggestions: false,
                  autocorrect: false,
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: _showToken ? 13 : 14,
                    letterSpacing: _showToken ? 0 : 1.2,
                  ),
                  decoration: const InputDecoration(
                    isDense: true,
                    hintText: 'Colle le token du tunnel',
                    hintStyle: TextStyle(color: _muted),
                    border: InputBorder.none,
                  ),
                  onSubmitted: (_) => _saveToken(),
                ),
              ),
              IconButton(
                tooltip: _showToken ? 'Masquer le token' : 'Afficher le token',
                visualDensity: VisualDensity.compact,
                onPressed: _domainBusy ? null : () => setState(() => _showToken = !_showToken),
                icon: Icon(
                  _showToken ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                  color: Colors.white70,
                ),
              ),
              IconButton(
                tooltip: 'Enregistrer le token',
                visualDensity: VisualDensity.compact,
                onPressed: _domainBusy ? null : _saveToken,
                icon: const Icon(Icons.check_rounded, color: _accent),
              ),
              if (_editingToken)
                IconButton(
                  tooltip: 'Annuler',
                  visualDensity: VisualDensity.compact,
                  onPressed: _domainBusy
                      ? null
                      : () => setState(() {
                            _editingToken = false;
                            _showToken = true;
                            _tokenCtrl.clear();
                          }),
                  icon: const Icon(Icons.close_rounded, color: _muted),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 30, right: 8, bottom: 8),
            child: Text(
              count == 0
                  ? 'Le token reste visible le temps de vérifier le collage.'
                  : '$count caractères${short ? ' — trop court' : ''}',
              style: TextStyle(color: short ? _accent : _muted, fontSize: 12),
            ),
          ),
        ],
      );
    }

    final up = _domainUp;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(Icons.lock_rounded, color: up ? _ok : _accent, size: 22),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                _tokenMask.isEmpty ? 'Token enregistré' : _tokenMask,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 14),
              ),
            ),
            IconButton(
              tooltip: 'Modifier le token',
              visualDensity: VisualDensity.compact,
              onPressed: _domainBusy
                  ? null
                  : () => setState(() {
                        _editingToken = true;
                        _showToken = true;
                        _tokenCtrl.clear();
                      }),
              icon: const Icon(Icons.edit_rounded, color: Colors.white),
            ),
            IconButton(
              tooltip: 'Supprimer le token',
              visualDensity: VisualDensity.compact,
              onPressed: _domainBusy ? null : _deleteToken,
              icon: const Icon(Icons.delete_outline_rounded, color: Colors.white70),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(left: 30, bottom: 8),
          child: Text(
            up ? 'Actif' : 'Inactif',
            style: TextStyle(color: up ? _ok : _muted, fontSize: 12),
          ),
        ),
      ],
    );
  }

  Widget _buildServerHostRow() {
    final host = _domainUrl.replaceFirst(RegExp(r'^https?://'), '');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            host.isEmpty ? 'Ce serveur n’a pas encore d’adresse.' : 'Ce serveur',
            style: const TextStyle(color: _muted, fontSize: 12),
          ),
          if (host.isNotEmpty)
            Row(
              children: [
                Expanded(
                  child: Text(
                    host,
                    style: const TextStyle(color: Colors.white, fontSize: 14),
                  ),
                ),
                IconButton(
                  tooltip: 'Copier l’adresse',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => _copy(_domainUrl, done: 'Adresse copiée'),
                  icon: const Icon(Icons.copy_rounded, color: _accent, size: 20),
                ),
              ],
            ),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Cloudflare : $_serviceUrl',
                  style: TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
              IconButton(
                tooltip: 'Copier localhost:3001',
                visualDensity: VisualDensity.compact,
                onPressed: () => _copy(_serviceUrl, done: 'localhost:3001 copié'),
                icon: const Icon(Icons.copy_rounded, color: _accent, size: 20),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _showDomainHelp() {
    showDialog<void>(
      context: context,
      builder: (context) {
        return AlertDialog(
          backgroundColor: _card,
          title: const Text('Créer mon domaine', style: TextStyle(color: Colors.white)),
          content: const SingleChildScrollView(
            child: Text(
              'Exemple avec Cloudflare.\n\n'
              '1. Dans Cloudflare Zero Trust, crée un tunnel.\n'
              '2. Ajoute un nom public : ton sous-domaine et ton domaine.\n'
              '3. Type de service : HTTP. URL : localhost:3001. Laisse le chemin vide.\n'
              '4. Enregistre, puis copie le token long. L’identifiant avec des tirets n’est pas le token.\n'
              '5. Ici, colle ton adresse https://… et ce token, puis active Mon domaine.\n\n'
              'localhost:3001 est le serveur de cette tablette. Il est le même sur chaque appareil. '
              'C’est le token collé ici qui relie ton domaine à cette tablette.\n\n'
              'Le téléphone ouvre ensuite cette adresse. Le compte se crée sur cette tablette.',
              style: TextStyle(color: Colors.white, height: 1.35),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Compris', style: TextStyle(color: _accent)),
            ),
          ],
        );
      },
    );
  }
}

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) => const SettingsPanel();
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
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}
