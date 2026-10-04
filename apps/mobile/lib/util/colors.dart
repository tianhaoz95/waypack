import 'package:flutter/material.dart';

/// Parses "#RRGGBB" from manifest.theme; null if absent or invalid.
Color? hexColor(String? hex) {
  if (hex == null || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(hex)) return null;
  return Color(int.parse('FF${hex.substring(1)}', radix: 16));
}

/// Readable text colour on top of [c].
Color onColor(Color c) =>
    c.computeLuminance() > 0.45 ? const Color(0xFF0F172A) : Colors.white;
