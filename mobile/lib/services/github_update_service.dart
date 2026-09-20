import 'package:flutter/services.dart';

class GithubUpdateStatus {
  const GithubUpdateStatus({
    required this.ok,
    required this.available,
    required this.message,
    this.restart = false,
    this.install = false,
    this.local = '',
    this.remote = '',
  });

  final bool ok;
  final bool available;
  final bool restart;
  final bool install;
  final String message;
  final String local;
  final String remote;

  factory GithubUpdateStatus.from(dynamic raw) {
    final map = <String, dynamic>{};
    if (raw is Map) {
      raw.forEach((key, value) {
        map['$key'] = value;
      });
    }
    final local = '${map['local'] ?? ''}'.trim();
    final remote = '${map['remote'] ?? ''}'.trim();
    final flagged = _asBool(map['available']);
    // Filet de sécurité : si le native renvoie local/remote, on recalcule.
    final bySemver = remote.isNotEmpty && isNewerVersion(remote, local);
    return GithubUpdateStatus(
      ok: _asBool(map['ok']),
      available: flagged || bySemver,
      restart: _asBool(map['restart']),
      install: _asBool(map['install']),
      message: '${map['message'] ?? ''}',
      local: local,
      remote: remote,
    );
  }

  static bool _asBool(dynamic value) {
    if (value == true) return true;
    if (value == false || value == null) return false;
    if (value is num) return value != 0;
    final s = '$value'.trim().toLowerCase();
    return s == 'true' || s == '1' || s == 'yes';
  }
}

/// Compare des tags style `v0.0.25` / `0.0.25` (aligné sur GithubUpdate.kt).
bool isNewerVersion(String remote, String local) {
  final rRaw = remote.trim();
  final lRaw = local.trim();
  if (rRaw.isEmpty) return false;
  if (lRaw.isEmpty) return true;
  final r = _semver(_key(rRaw));
  final l = _semver(_key(lRaw));
  if (r == null || l == null) return _key(rRaw) != _key(lRaw);
  for (var i = 0; i < 3; i++) {
    if (r[i] != l[i]) return r[i] > l[i];
  }
  return false;
}

String _key(String tag) {
  final t = tag.trim();
  if (t.toLowerCase().startsWith('v')) return t.substring(1);
  return t;
}

List<int>? _semver(String version) {
  final parts = version.split(RegExp(r'[.+\-]'));
  if (parts.isEmpty || int.tryParse(parts[0]) == null) return null;
  return [
    int.tryParse(parts.isNotEmpty ? parts[0] : '') ?? 0,
    int.tryParse(parts.length > 1 ? parts[1] : '') ?? 0,
    int.tryParse(parts.length > 2 ? parts[2] : '') ?? 0,
  ];
}

class GithubUpdateProgress {
  const GithubUpdateProgress({required this.pct, required this.label});

  final double pct;
  final String label;
}

class GithubUpdateService {
  GithubUpdateService._();
  static final GithubUpdateService instance = GithubUpdateService._();
  static const _ch = MethodChannel('gamelle/github');
  static const _progress = EventChannel('gamelle/github_progress');

  Stream<GithubUpdateProgress> get progress async* {
    await for (final raw in _progress.receiveBroadcastStream()) {
      final map = raw is Map ? Map<Object?, Object?>.from(raw) : const <Object?, Object?>{};
      final pct = (map['pct'] as num?)?.toDouble() ?? 0;
      yield GithubUpdateProgress(pct: pct.clamp(0, 1), label: '${map['label'] ?? ''}');
    }
  }

  Future<GithubUpdateStatus> check() async {
    final raw = await _ch.invokeMethod<dynamic>('status');
    return GithubUpdateStatus.from(raw);
  }

  Future<GithubUpdateStatus> apply() async {
    final raw = await _ch.invokeMethod<dynamic>('apply');
    return GithubUpdateStatus.from(raw);
  }
}
