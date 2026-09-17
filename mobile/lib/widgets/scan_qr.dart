import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// QR noir sur blanc, avec marge de lecture (Xiaomi / caméra téléphone).
class ScanQr extends StatelessWidget {
  const ScanQr({super.key, required this.data, this.size = 240});

  final String data;
  final double size;

  @override
  Widget build(BuildContext context) {
    return MediaQuery(
      data: MediaQuery.of(context).copyWith(platformBrightness: Brightness.light),
      child: Theme(
        data: ThemeData.light(),
        child: Container(
          width: size,
          height: size,
          color: const Color(0xFFFFFFFF),
          alignment: Alignment.center,
          child: QrImageView(
            data: data,
            version: QrVersions.auto,
            errorCorrectionLevel: QrErrorCorrectLevel.M,
            gapless: true,
            size: size,
            padding: const EdgeInsets.all(20),
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
      ),
    );
  }
}
