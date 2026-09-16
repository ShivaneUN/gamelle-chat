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

  Future<String> loadToken() async {
    try {
      return '${await _ch.invokeMethod<String>('loadToken') ?? ''}';
    } catch (_) {
      return '';
    }
  }

  Future<void> saveToken(String token) async {
    try {
      await _ch.invokeMethod<void>('saveToken', token);
    } catch (_) {}
  }

  Future<GithubUpdateStatus> check(String token) async {
    final raw = await _ch.invokeMethod<dynamic>('status', {'token': token});
    return GithubUpdateStatus.from(raw);
  }

  Future<GithubUpdateStatus> apply(String token) async {
    final raw = await _ch.invokeMethod<dynamic>('apply', {'token': token});
    return GithubUpdateStatus.from(raw);
  }
}
