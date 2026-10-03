import 'dart:async';

import 'package:flutter/services.dart';

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
}
