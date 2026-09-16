import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// QR noir sur blanc, insensible au thème sombre Xiaomi.
class ScanQr extends StatelessWidget {
  const ScanQr({super.key, required this.data, this.size = 204});

  final String data;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: ThemeData.light(),
      child: Container(
        width: size,
        height: size,
        color: const Color(0xFFFFFFFF),
        alignment: Alignment.center,
        child: QrImageView(
          data: data,
          size: size - 24,
          padding: const EdgeInsets.all(12),
          backgroundColor: const Color(0xFFFFFFFF),
          eyeStyle: const QrEyeStyle(
            eyeShape: QrEyeShape.square,
            color: Color(0xFF000000),
          ),
          dataModuleStyle: const QrDataModuleStyle(
            dataModuleShape: QrDataModuleShape.square,
            color: Color(0xFF000000),
          ),
        ),
      ),
    );
  }
}
