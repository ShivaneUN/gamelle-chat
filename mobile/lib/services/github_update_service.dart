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

class GithubUpdateService {
  GithubUpdateService._();
  static final GithubUpdateService instance = GithubUpdateService._();
  static const _ch = MethodChannel('gamelle/github');

  Future<GithubUpdateStatus> check() async {
    final raw = await _ch.invokeMethod<dynamic>('status');
    return GithubUpdateStatus.from(raw);
  }

  Future<GithubUpdateStatus> apply() async {
    final raw = await _ch.invokeMethod<dynamic>('apply');
    return GithubUpdateStatus.from(raw);
  }
}
