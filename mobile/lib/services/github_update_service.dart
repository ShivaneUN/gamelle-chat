import 'package:flutter/services.dart';

class GithubUpdateStatus {
  const GithubUpdateStatus({
    required this.ok,
    required this.available,
    required this.message,
    this.restart = false,
  });

  final bool ok;
  final bool available;
  final bool restart;
  final String message;

  factory GithubUpdateStatus.from(dynamic raw) {
    final map = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    return GithubUpdateStatus(
      ok: map['ok'] == true,
      available: map['available'] == true,
      restart: map['restart'] == true,
      message: '${map['message'] ?? ''}',
    );
  }
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
