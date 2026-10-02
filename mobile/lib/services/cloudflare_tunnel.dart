import 'dart:async';

import 'package:flutter/services.dart';

class CustomDomainStatus {
  const CustomDomainStatus({
    required this.enabled,
    required this.publicUrl,
    required this.hasToken,
  });

  final bool enabled;
  final String publicUrl;
  final bool hasToken;

  factory CustomDomainStatus.fromMap(Map<dynamic, dynamic>? map) {
    final m = map ?? const {};
    return CustomDomainStatus(
      enabled: m['enabled'] == true,
      publicUrl: '${m['publicUrl'] ?? ''}',
      hasToken: m['hasToken'] == true,
    );
  }
}

class CloudflareTunnel {
  CloudflareTunnel._();

  static const _methods = MethodChannel('gamelle/cloudflare');
  static const _events = EventChannel('gamelle/cloudflare_events');

  static Stream<Map<String, dynamic>> events() {
    return _events.receiveBroadcastStream().map((event) {
      return Map<String, dynamic>.from(event as Map);
    });
  }

  static Future<void> start() {
    return _methods.invokeMethod<void>('start');
  }

  static Future<void> stop() {
    return _methods.invokeMethod<void>('stop');
  }

  /// Statut domaine perso — **jamais** le token.
  static Future<CustomDomainStatus> getCustomDomain() async {
    final raw = await _methods.invokeMethod<dynamic>('getCustomDomain');
    return CustomDomainStatus.fromMap(raw is Map ? raw : null);
  }

  /// Enregistre domaine / token (token optionnel, write-only).
  static Future<CustomDomainStatus> setCustomDomain({
    required bool enabled,
    String? publicUrl,
    String? token,
  }) async {
    final args = <String, dynamic>{'enabled': enabled};
    if (publicUrl != null) args['publicUrl'] = publicUrl;
    if (token != null && token.isNotEmpty) args['token'] = token;
    final raw = await _methods.invokeMethod<dynamic>('setCustomDomain', args);
    return CustomDomainStatus.fromMap(raw is Map ? raw : null);
  }

  static Future<CustomDomainStatus> clearCustomDomainToken() async {
    final raw = await _methods.invokeMethod<dynamic>('clearCustomDomainToken');
    return CustomDomainStatus.fromMap(raw is Map ? raw : null);
  }
}
